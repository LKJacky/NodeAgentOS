"""The stateless node side of the Python SDK, shaped like the TypeScript ``Node``.

A node has ``ctx``, a ``handlers`` map, an optional ``on_event`` and ``dispose``. ``Host`` creates
one instance per invocation, so an instance field only lives for that turn.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

from .bus import BusClient

Json = dict[str, Any]
NodeHandler = Callable[[Mapping[str, Any]], Awaitable[Any] | Any]


def _default_home(node_id: str) -> tuple[str, str]:
    import os
    from pathlib import Path

    root = os.environ.get("NODE_AGENT_HOME") or str(Path.home() / ".node_agent")
    return root, str(Path(root) / node_id)


@dataclass(frozen=True)
class NodeContext:
    """One invocation's identity, deadline and bus access.

    The names mirror the TypeScript context in snake_case: ``tenantId`` is ``tenant_id``,
    ``nodeId`` is ``node_id`` and ``from`` is ``from_node``. ``tenant``/``node_name`` remain as
    short aliases for handlers that already use them.
    """

    tenant_id: str
    from_node: str
    node_id: str
    deadline: int
    signal: asyncio.Event
    bus: BusClient | None = None
    node_agent_home: str = ""
    home: str = ""

    def __post_init__(self) -> None:
        if not self.node_agent_home or not self.home:
            root, own = _default_home(self.node_id)
            object.__setattr__(self, "node_agent_home", self.node_agent_home or root)
            object.__setattr__(self, "home", self.home or own)

    @property
    def tenant(self) -> str:
        return self.tenant_id

    @property
    def node_name(self) -> str:
        return self.node_id

    async def call(self, node: str, capability: str, args: Mapping[str, Any] | None = None) -> Any:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        return await self.bus.call(node, capability, args, tenant=self.tenant_id)

    async def list_nodes(self) -> list[Json]:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        return await self.bus.list_nodes(self.tenant_id)

    async def list_capabilities(self, node: str) -> list[Json]:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        return await self.bus.list_capabilities(node, self.tenant_id)

    async def subscribe(self, node: str, topic: str) -> None:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        await self.bus.subscribe(node, topic, tenant=self.tenant_id)

    async def unsubscribe(self, node: str, topic: str) -> None:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        await self.bus.unsubscribe(node, topic, tenant=self.tenant_id)

    async def publish(self, topic: str, value: Any) -> None:
        if self.bus is None:
            raise RuntimeError("this context has no bus")
        await self.bus.publish(topic, value, tenant=self.tenant_id)


# Alias used by the first version of this package.
CallContext = NodeContext


class Node:
    """One stateless node implementation.

    ``handlers`` maps a capability name to a callable taking only its argument object. The handler
    reads ``self.ctx`` for tenant, caller, deadline and bus access, exactly like the TypeScript Node.

    Example::

        class Echo(Node):
            name = "echo"
            caps = {"say": {"type": "object", "properties": {"text": {"type": "string"}}}}

            def __init__(self, ctx):
                super().__init__(ctx)
                self.handlers = {"say": self.say}

            async def say(self, args):
                return args["text"]
    """

    name = ""
    desc = ""
    version = "0.1.0"
    publisher = ""
    package_id = ""
    icon = ""
    caps: Mapping[str, Json] = {}
    bindings: tuple[str, ...] = ()

    def __init__(self, ctx: NodeContext) -> None:
        self.ctx = ctx
        self.handlers: Mapping[str, NodeHandler] = {}

    @classmethod
    def manifest(
        cls,
        *,
        name: str | None = None,
        desc: str | None = None,
        version: str | None = None,
        publisher: str | None = None,
        package_id: str | None = None,
        icon: str | None = None,
    ) -> Json:
        node_name = name or cls.name
        if not node_name:
            raise ValueError("a node needs a name")
        value: Json = {
            "packageId": package_id or cls.package_id or node_name,
            "name": node_name,
            "desc": desc if desc is not None else cls.desc,
            "version": version if version is not None else cls.version,
            "publisher": publisher if publisher is not None else cls.publisher,
            "icon": icon if icon is not None else cls.icon,
            "caps": dict(cls.caps),
        }
        if cls.bindings:
            value["bindings"] = list(cls.bindings)
        return value

    async def dispose(self) -> None:
        """Called after every invocation; transient resources belong here."""

    async def on_event(self, topic: str, value: Any, from_node: str) -> None:
        """Optional event hook; the host creates a fresh node per event too."""
