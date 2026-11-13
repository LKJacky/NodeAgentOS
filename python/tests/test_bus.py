import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from node_agent_sdk import BusClient, BusError, CallContext, Host, Node


class Echo(Node):
    name = "echo"
    desc = "echo one argument"
    caps = {"say": {"type": "object", "properties": {"text": {"type": "string"}}}}

    def __init__(self, ctx):
        super().__init__(ctx)
        self.handlers = {"say": self.say}

    async def say(self, args):
        return {"text": args["text"], "tenant": self.ctx.tenant}


class Counter(Node):
    name = "counter"
    caps = {"inc": {"type": "object", "properties": {}}}
    made = 0

    def __init__(self, ctx):
        super().__init__(ctx)
        type(self).made += 1
        self.value = 0

        self.handlers = {"inc": self.inc}

    async def inc(self, args):
        self.value += 1
        return self.value


class BusTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_call_is_answered_with_a_result_frame(self) -> None:
        client = BusClient("ws://bus")
        sent = []

        async def send(frame):
            sent.append(frame)

        client._send = send  # type: ignore[method-assign]
        client.on_call(lambda call: {"ok": True, "value": call["payload"]["args"]})
        await client._answer_call(
            {
                "id": "call-1",
                "type": "call",
                "from": "agent",
                "tenantId": "tenant",
                "payload": {"cap": "echo", "args": {"x": 1}},
            }
        )
        self.assertEqual(sent[0]["type"], "result")
        self.assertEqual(sent[0]["replyTo"], "call-1")
        self.assertEqual(sent[0]["payload"], {"ok": True, "value": {"x": 1}})

    async def test_a_handler_error_is_returned_as_data(self) -> None:
        client = BusClient("ws://bus")
        sent = []

        async def send(frame):
            sent.append(frame)

        client._send = send  # type: ignore[method-assign]
        client.on_call(lambda _call: (_ for _ in ()).throw(ValueError("no")))
        await client._answer_call({"id": "call-2", "from": "agent", "payload": {}})
        self.assertEqual(sent[0]["payload"], {"ok": False, "error": "no"})

    async def test_an_empty_address_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            BusClient(" ")

    async def test_a_node_dispatches_by_capability_name(self) -> None:
        host = Host(Echo, "ws://bus")
        host._started = True
        answer = await host.invoke(
            {
                "id": "1",
                "to": "echo",
                "from": "agent",
                "tenantId": "alice",
                "payload": {"cap": "say", "args": {"text": "hi"}},
            }
        )
        self.assertEqual(answer, {"ok": True, "value": {"text": "hi", "tenant": "alice"}})
        self.assertEqual(Echo.manifest()["name"], "echo")

    async def test_an_unknown_node_capability_is_refused(self) -> None:
        host = Host(Echo, "ws://bus")
        host._started = True
        answer = await host.invoke(
            {"id": "1", "to": "echo", "from": "agent", "payload": {"cap": "missing"}}
        )
        self.assertFalse(answer["ok"])

    async def test_host_creates_a_fresh_node_for_every_call(self) -> None:
        Counter.made = 0
        host = Host(Counter, "ws://bus")
        host._started = True
        call = {"id": "1", "type": "call", "to": "counter", "from": "agent", "tenantId": "alice", "payload": {"cap": "inc", "args": {}}}
        first = await host.invoke(call)
        second = await host.invoke(call)
        self.assertEqual(first, {"ok": True, "value": 1})
        self.assertEqual(second, {"ok": True, "value": 1})
        self.assertEqual(Counter.made, 2)

    async def test_host_refuses_an_unknown_capability(self) -> None:
        host = Host(Counter, "ws://bus")
        host._started = True
        answer = await host.invoke(
            {"id": "1", "to": "counter", "from": "agent", "payload": {"cap": "nope"}}
        )
        self.assertEqual(answer["ok"], False)

    async def test_bus_error_keeps_the_message(self) -> None:
        error = BusError("refused")
        self.assertEqual(str(error), "refused")


if __name__ == "__main__":
    unittest.main()
