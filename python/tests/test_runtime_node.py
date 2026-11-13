import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from node_agent_runtime import RuntimeNode
from node_agent_sdk import NodeContext


class FakeBus:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []

    async def list_nodes(self, tenant):
        self.calls.append(("list_nodes", (tenant,)))
        return [{"name": "history"}]

    async def list_capabilities(self, node, tenant):
        self.calls.append(("list_capabilities", (node, tenant)))
        return [{"name": "list"}]

    async def call(self, node, cap, args, *, tenant):
        self.calls.append(("call", (node, cap, args, tenant)))
        return {"ok": True}

    async def publish(self, topic, value, *, tenant):
        self.calls.append(("publish", (topic, value, tenant)))

    async def subscribe(self, node, topic, *, tenant):
        self.calls.append(("subscribe", (node, topic, tenant)))

    async def unsubscribe(self, node, topic, *, tenant):
        self.calls.append(("unsubscribe", (node, topic, tenant)))


class RuntimeNodeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.bus = FakeBus()
        self.node = RuntimeNode(
            NodeContext("tenant", "agent", "runtime", 0, None, self.bus)  # type: ignore[arg-type]
        )

    def test_exposes_no_bus_capabilities(self) -> None:
        manifest = RuntimeNode.manifest()
        self.assertEqual(manifest["name"], "runtime")
        self.assertEqual(manifest["caps"], {})
        self.assertEqual(self.node.handlers, {})

    async def test_nodes_and_capabilities_use_the_context_bus(self) -> None:
        self.assertEqual(await self.node.nodes(), [{"name": "history"}])
        self.assertEqual(await self.node.capabilities("history"), [{"name": "list"}])
        self.assertIn(("list_nodes", ("tenant",)), self.bus.calls)

    async def test_call_uses_the_caller_tenant(self) -> None:
        value = await self.node.call("history", "list", {"unitId": "notes"})
        self.assertEqual(value, {"ok": True})
        self.assertIn(
            ("call", ("history", "list", {"unitId": "notes"}, "tenant")), self.bus.calls
        )

    async def test_events_use_the_context_bus(self) -> None:
        await self.node.publish("t", 1)
        await self.node.subscribe("history", "t")
        await self.node.unsubscribe("history", "t")
        self.assertIn(("publish", ("t", 1, "tenant")), self.bus.calls)
        self.assertIn(("subscribe", ("history", "t", "tenant")), self.bus.calls)
        self.assertIn(("unsubscribe", ("history", "t", "tenant")), self.bus.calls)


if __name__ == "__main__":
    unittest.main()
