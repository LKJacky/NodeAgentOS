"""The stateless host for Python nodes.

The host owns the bus connection and the manifest. Every inbound call gets a fresh ``Node``
instance, runs the handler from ``node.handlers`` and disposes the instance in a ``finally`` block.
Nothing the handler stores on ``self`` survives the call.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Mapping

from .bus import BusClient
from .node import Node, NodeContext

Json = dict[str, Any]
AfterRegister = Callable[["Host"], Awaitable[None] | None]


def _deadline(value: Any, timeout: float) -> int:
    now = int(time.time() * 1000)
    if isinstance(value, (int, float)) and value > now:
        return int(value)
    return now + int(timeout * 1000)


class Host:
    """Register one node class and instantiate it per call."""

    def __init__(
        self,
        node_class: type[Node],
        bus_url: str,
        bus_token: str = "",
        *,
        name: str | None = None,
        desc: str | None = None,
        version: str | None = None,
        publisher: str | None = None,
        package_id: str | None = None,
        icon: str | None = None,
        node_kwargs: Mapping[str, Any] | None = None,
        after_register: AfterRegister | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.node_class = node_class
        self.manifest = node_class.manifest(
            name=name,
            desc=desc,
            version=version,
            publisher=publisher,
            package_id=package_id,
            icon=icon,
        )
        self.bus = BusClient(bus_url, bus_token, timeout=timeout)
        self.bus.on_call(self._on_call)
        self.bus.on_event(self._on_event)
        self._node_kwargs = dict(node_kwargs or {})
        self._after_register = after_register
        self._timeout = timeout
        self._stopped = asyncio.Event()
        self.ready = asyncio.Event()
        self._started = False
        root = os.environ.get("NODE_AGENT_HOME") or str(Path.home() / ".node_agent")
        self.node_agent_home = root
        self.home = str(Path(root) / self.name)

    @property
    def name(self) -> str:
        return str(self.manifest["name"])

    async def start(self) -> None:
        if self._started:
            return
        if self._stopped.is_set():
            raise RuntimeError("host is stopped")
        await self.bus.connect()
        try:
            await self.bus.register(self.manifest)
            self._started = True
            self.ready.set()
            if self._after_register is not None:
                value = self._after_register(self)
                if inspect.isawaitable(value):
                    await value
        except Exception:
            await self._disconnect()
            raise

    async def run(self) -> None:
        """Start and serve until ``stop`` or cancellation. Reconnects if the bus drops."""
        try:
            import aiohttp  # noqa: F401
        except ImportError as error:
            raise RuntimeError("the bus SDK needs aiohttp: pip install -e '.[bus]'") from error

        while not self._stopped.is_set():
            try:
                await self.start()
                print(f"node {self.name}: on {self.bus.url}", flush=True)
                await self.bus.wait_closed()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if not self._stopped.is_set():
                    print(f"node {self.name}: {error}", flush=True)
            finally:
                await self._disconnect()
            if not self._stopped.is_set():
                await asyncio.sleep(1.0)

    async def stop(self) -> None:
        self._stopped.set()
        await self._disconnect()

    async def _disconnect(self) -> None:
        if self._started:
            try:
                await self.bus.unregister(self.name)
            except Exception:
                pass
        self._started = False
        self.ready.clear()
        await self.bus.close()

    def _context(self, call: Mapping[str, Any], deadline: int, signal: asyncio.Event) -> NodeContext:
        return NodeContext(
            tenant_id=str(call.get("tenantId", "*")),
            from_node=str(call.get("from", "")),
            node_id=self.name,
            deadline=deadline,
            signal=signal,
            bus=self.bus,
            node_agent_home=self.node_agent_home,
            home=self.home,
        )

    async def invoke(self, call: Mapping[str, Any]) -> Json:
        """Execute one call envelope. Public so tests do not need a socket."""
        if not self._started:
            return {"ok": False, "error": "host is not started"}
        if self._stopped.is_set():
            return {"ok": False, "error": "host is stopped"}
        if call.get("to") != self.name:
            return {"ok": False, "error": f"wrong node: {call.get('to')}"}
        payload = call.get("payload", {})
        capability = str(payload.get("cap", ""))
        if capability not in self.manifest["caps"]:
            return {"ok": False, "error": f"unknown capability: {capability}"}
        deadline = _deadline(call.get("deadline"), self._timeout)
        remaining = max(0, deadline - int(time.time() * 1000)) / 1000
        if remaining <= 0:
            return {"ok": False, "error": "deadline exceeded"}
        signal = asyncio.Event()
        ctx = self._context(call, deadline, signal)
        node = self.node_class(ctx, **self._node_kwargs)
        try:
            handler = node.handlers.get(capability)
            if not callable(handler):
                return {"ok": False, "error": f"node {self.name} has no handler for {capability}"}
            value = handler(payload.get("args", {}) if isinstance(payload.get("args"), dict) else {})
            if inspect.isawaitable(value):
                value = await asyncio.wait_for(value, timeout=remaining)
            return {"ok": True, "value": value}
        except asyncio.TimeoutError:
            signal.set()
            return {"ok": False, "error": "deadline exceeded"}
        except Exception as error:
            return {"ok": False, "error": str(error)}
        finally:
            try:
                await node.dispose()
            except Exception:
                pass

    async def _on_call(self, call: Json) -> Json:
        return await self.invoke(call)

    async def _on_event(self, event: Json) -> None:
        if not self._started or self._stopped.is_set():
            return
        payload = event.get("payload", {})
        deadline = _deadline(None, self._timeout)
        signal = asyncio.Event()
        ctx = self._context(event, deadline, signal)
        node = self.node_class(ctx, **self._node_kwargs)
        try:
            await asyncio.wait_for(
                node.on_event(
                    str(payload.get("topic", "")),
                    payload.get("value"),
                    str(event.get("from", "")),
                ),
                timeout=max(1.0, self._timeout),
            )
        except Exception:
            pass
        finally:
            try:
                await node.dispose()
            except Exception:
                pass
