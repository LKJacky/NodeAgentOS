"""A small Python client for the NodeAgent bus protocol.

The SDK stops at the transport. It connects, registers a node manifest, calls other nodes, lists
the directory and receives calls. It does not render pages or load i18n resources.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Mapping
from urllib.parse import quote

Json = dict[str, Any]
CallHandler = Callable[[Json], Awaitable[Json] | Json]
EventHandler = Callable[[Json], None]


class BusError(Exception):
    """The bus refused a request or the connection closed."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def _deadline(timeout: float) -> int:
    return int(time.time() * 1000) + int(timeout * 1000)


class BusClient:
    """One node's connection to the bus.

    ``connect`` opens the socket, ``register`` publishes a manifest, and ``call`` invokes one
    capability. Calls carry the tenant the caller wants to act as; the bus is the authority on
    whether that tenant exists and whether the caller may reach the target.
    """

    def __init__(self, url: str, token: str = "", *, timeout: float = 10.0) -> None:
        address = url.strip()
        if not address:
            raise ValueError("a bus client needs an address")
        self.url = address
        self.token = token.strip()
        self.timeout = timeout
        self._ws: Any = None
        self._session: Any = None
        self._reader: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[Json]] = {}
        self._closed = asyncio.Event()
        self._call_handler: CallHandler | None = None
        self._event_handler: EventHandler | None = None

    async def connect(self) -> None:
        import aiohttp

        if self._ws is not None:
            raise BusError("bus client is already connected")
        endpoint = self.url
        if self.token:
            endpoint += ("&" if "?" in endpoint else "?") + "token=" + quote(self.token, safe="")
        self._session = aiohttp.ClientSession()
        try:
            self._ws = await self._session.ws_connect(endpoint, heartbeat=30)
        except Exception:
            await self._session.close()
            self._session = None
            raise
        self._closed.clear()
        self._reader = asyncio.create_task(self._read_loop())

    async def close(self) -> None:
        self._closed.set()
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
            self._reader = None
        if self._session is not None:
            await self._session.close()
            self._session = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BusError("bus connection closed"))
        self._pending.clear()

    async def wait_closed(self) -> None:
        await self._closed.wait()

    def on_call(self, handler: CallHandler) -> None:
        self._call_handler = handler

    def on_event(self, handler: EventHandler) -> None:
        self._event_handler = handler

    async def register(self, manifest: Mapping[str, Any]) -> None:
        result = await self._request(
            {
                "id": uuid.uuid4().hex,
                "type": "register",
                "to": str(manifest.get("name", "")),
                "tenantId": "*",
                "deadline": _deadline(self.timeout),
                "payload": {"manifest": dict(manifest), "chunks": False},
            }
        )
        _ok(result)

    async def unregister(self, name: str) -> None:
        await self._send(
            {
                "id": uuid.uuid4().hex,
                "type": "unregister",
                "to": name,
                "tenantId": "*",
                "payload": {"name": name},
            }
        )

    async def call(
        self,
        node: str,
        capability: str,
        args: Mapping[str, Any] | None = None,
        *,
        tenant: str = "*",
        from_node: str | None = None,
    ) -> Any:
        """Call a node. Only a bus super connection may choose ``from_node``."""
        frame = {
            "id": uuid.uuid4().hex,
            "type": "call",
            "to": node,
            "tenantId": tenant,
            "deadline": _deadline(self.timeout),
            "payload": {"cap": capability, "args": dict(args or {})},
        }
        if from_node is not None:
            frame["from"] = from_node
        return _ok(await self._request(frame))

    async def list_nodes(self, tenant: str = "*") -> list[Json]:
        result = await self._request(
            {
                "id": uuid.uuid4().hex,
                "type": "list_nodes",
                "to": "bus",
                "tenantId": tenant,
                "deadline": _deadline(self.timeout),
                "payload": {},
            }
        )
        value = _ok(result)
        return value if isinstance(value, list) else []

    async def list_capabilities(self, node: str, tenant: str = "*") -> list[Json]:
        result = await self._request(
            {
                "id": uuid.uuid4().hex,
                "type": "list_capabilities",
                "to": "bus",
                "tenantId": tenant,
                "deadline": _deadline(self.timeout),
                "payload": {"node": node},
            }
        )
        value = _ok(result)
        return value if isinstance(value, list) else []

    async def publish(self, topic: str, value: Any, *, tenant: str = "*") -> None:
        await self._send(
            {
                "id": uuid.uuid4().hex,
                "type": "event",
                "to": "*",
                "tenantId": tenant,
                "payload": {"topic": topic, "value": value},
            }
        )

    async def subscribe(self, node: str, topic: str, *, tenant: str = "*") -> None:
        result = await self._request(
            {
                "id": uuid.uuid4().hex,
                "type": "subscribe",
                "to": "bus",
                "tenantId": tenant,
                "deadline": _deadline(self.timeout),
                "payload": {"node": node, "topic": topic},
            }
        )
        _ok(result)

    async def unsubscribe(self, node: str, topic: str, *, tenant: str = "*") -> None:
        result = await self._request(
            {
                "id": uuid.uuid4().hex,
                "type": "unsubscribe",
                "to": "bus",
                "tenantId": tenant,
                "deadline": _deadline(self.timeout),
                "payload": {"node": node, "topic": topic},
            }
        )
        _ok(result)

    async def _request(self, frame: Json) -> Json:
        future: asyncio.Future[Json] = asyncio.get_running_loop().create_future()
        self._pending[frame["id"]] = future
        try:
            await self._send(frame)
            return await asyncio.wait_for(future, timeout=max(1.0, self.timeout))
        finally:
            self._pending.pop(frame["id"], None)

    async def _send(self, frame: Json) -> None:
        if self._ws is None:
            raise BusError("bus client is not connected")
        try:
            await self._ws.send_json(frame)
        except Exception as error:
            raise BusError(f"bus send failed: {error}") from None

    async def _read_loop(self) -> None:
        from aiohttp import WSMsgType

        assert self._ws is not None
        try:
            async for message in self._ws:
                if message.type != WSMsgType.TEXT or not isinstance(message.data, str):
                    if message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                        break
                    continue
                frame = json.loads(message.data)
                if frame.get("type") == "result":
                    future = self._pending.get(frame.get("replyTo", ""))
                    if future is not None and not future.done():
                        future.set_result(frame)
                elif frame.get("type") == "call":
                    asyncio.create_task(self._answer_call(frame))
                elif frame.get("type") == "event" and self._event_handler is not None:
                    self._event_handler(frame)
        finally:
            self._closed.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(BusError("bus connection closed"))

    async def _answer_call(self, call: Json) -> None:
        try:
            if self._call_handler is None:
                outcome: Json = {
                    "ok": False,
                    "error": f"no handler for {call.get('payload', {}).get('cap', '')}",
                }
            else:
                value = self._call_handler(call)
                if inspect.isawaitable(value):
                    value = await value
                outcome = value if isinstance(value, dict) else {"ok": True, "value": value}
        except Exception as error:
            outcome = {"ok": False, "error": str(error)}
        try:
            await self._send(
                {
                    "id": uuid.uuid4().hex,
                    "type": "result",
                    "to": call.get("from", ""),
                    "replyTo": call.get("id", ""),
                    "tenantId": call.get("tenantId", "*"),
                    "payload": outcome,
                }
            )
        except BusError:
            pass


def _ok(result: Json) -> Any:
    payload = result.get("payload", {})
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        error = payload.get("error") if isinstance(payload, dict) else None
        raise BusError(str(error or "bus request failed"))
    return payload.get("value")
