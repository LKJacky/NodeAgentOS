"""A bus-facing helper for operating this tenant's bus.

``RuntimeNode`` is not registered on the bus and exposes no capabilities. It is a small wrapper
around ``NodeContext`` for code that already has a context and wants to list nodes, inspect
capabilities, call, publish or subscribe.
"""

from __future__ import annotations

from typing import Any, Mapping

from node_agent_sdk import Node, NodeContext

ICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    '<path d="M6 16h8m4 0h8M16 6v8m0 4v8" stroke="#38bdf8" stroke-width="3" '
    'stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#38bdf8"/>'
    "</svg>"
)


class RuntimeNode(Node):
    """Operate bus content with an invocation's context; never registered itself."""

    name = "runtime"
    package_id = "node-agent-runtime"
    desc = "Operate the bus: nodes, capabilities, calls and events"
    icon = ICON
    caps: Mapping[str, Any] = {}

    async def nodes(self) -> Any:
        return await self.ctx.list_nodes()

    async def capabilities(self, node: str) -> Any:
        return await self.ctx.list_capabilities(node)

    async def call(
        self, node: str, cap: str, args: Mapping[str, Any] | None = None
    ) -> Any:
        return await self.ctx.call(node, cap, args or {})

    async def publish(self, topic: str, value: Any) -> None:
        await self.ctx.publish(topic, value)

    async def subscribe(self, node: str, topic: str) -> None:
        await self.ctx.subscribe(node, topic)

    async def unsubscribe(self, node: str, topic: str) -> None:
        await self.ctx.unsubscribe(node, topic)
