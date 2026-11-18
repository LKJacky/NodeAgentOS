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


# The wire carries one frame in one WebSocket message up to this many bytes; past it a frame
# travels as `part` frames that the peer joins back into the one frame it was (bus/src/wire.ts).
MAX_FRAME_CHARS = 1 << 20
# A joined frame may be this big: one chat turn carries the whole transcript.
MAX_MESSAGE_CHARS = 512 << 20


def _pieces(text: str) -> list[str]:
    """`text` as the messages that carry it: itself when one message carries it whole."""
    if len(text.encode('utf-8')) <= MAX_FRAME_CHARS:
        return [text]
    if len(text) > MAX_MESSAGE_CHARS:
        raise BusError(
            'a frame of %d characters is past the %d this wire carries' % (len(text), MAX_MESSAGE_CHARS)
        )
    identity = uuid.uuid4().hex
    size = max(1, (MAX_FRAME_CHARS - 256) // 2)
    values: list[str] = []
    at = 0
    while at < len(text):
        end = min(len(text), at + size)
        piece = text[at:end]
        while len(json.dumps({'op': 'part', 'id': identity, 'seq': len(values), 'value': piece, 'last': False}).encode('utf-8')) > MAX_FRAME_CHARS and len(piece) > 1:
            end = at + max(1, len(piece) // 2)
            piece = text[at:end]
        values.append(piece)
        at += len(piece)
    return [
        json.dumps({'op': 'part', 'id': identity, 'seq': seq, 'value': value, 'last': seq == len(values) - 1})
        for seq, value in enumerate(values)
    ]


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
        self._parts: dict[str, list[str]] = {}
        self._parts_chars = 0
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
                "payload": {"manifest": dict(manifest), "chunks": True},
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
            text = json.dumps(frame)
            for piece in _pieces(text):
                await self._ws.send_str(piece)
        except BusError:
            raise
        except Exception as error:
            raise BusError(f"bus send failed: {error}") from None

    def _joined(self, frame: Json) -> Json | None:
        """The frame `frame` carries: itself, or the whole one its pieces add up to.

        A piece is held until the one marked `last` arrives, and the joined text is parsed and
        handed back as the one frame the sender wrote, however many messages carried it. A gap in
        the sequence drops the frame, and the total is bounded: a peer that streams pieces and
        never says last is not carrying a frame this client will hold.
        """
        if frame.get("op") != "part":
            return frame
        identity = frame.get("id")
        value = frame.get("value")
        seq = frame.get("seq")
        if not isinstance(identity, str) or not isinstance(value, str) or not isinstance(seq, int):
            return None
        pieces = self._parts.get(identity, [])
        if seq != len(pieces):
            self._forget(identity, pieces)
            return None
        pieces.append(value)
        self._parts[identity] = pieces
        self._parts_chars += len(value)
        if self._parts_chars > MAX_MESSAGE_CHARS:
            self._parts.clear()
            self._parts_chars = 0
            return None
        if frame.get("last") is not True:
            return None
        self._forget(identity, pieces)
        try:
            return json.loads("".join(pieces))
        except ValueError:
            return None

    def _forget(self, identity: str, pieces: list[str]) -> None:
        if self._parts.pop(identity, None) is None:
            return
        self._parts_chars -= sum(len(piece) for piece in pieces)

    async def _read_loop(self) -> None:
        from aiohttp import WSMsgType

        assert self._ws is not None
        try:
            async for message in self._ws:
                if message.type != WSMsgType.TEXT or not isinstance(message.data, str):
                    if message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                        break
                    continue
                frame = self._joined(json.loads(message.data))
                if frame is None:
                    continue
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
