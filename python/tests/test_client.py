import asyncio
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from node_agent_runtime import AsyncRuntimeClient, RuntimeError


class Handler(BaseHTTPRequestHandler):
    records: list[tuple[str, str, dict, dict]] = []

    def log_message(self, *_args) -> None:
        pass

    def _send(self, status: int, value: dict) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        size = int(self.headers.get("content-length", "0"))
        if size == 0:
            return {}
        return json.loads(self.rfile.read(size))

    def _authorized(self) -> bool:
        if self.path.split("?", 1)[0] == "/healthz":
            return True
        return self.headers.get("authorization") == "Bearer test-token"

    def _record(self, body: dict | None = None) -> None:
        Handler.records.append(
            (
                self.command,
                self.path,
                {key.lower(): value for key, value in self.headers.items()},
                body or {},
            )
        )

    def do_GET(self) -> None:
        self._record()
        if not self._authorized():
            self._send(401, {"error": "unauthorized", "code": "unauthorized"})
            return
        path = urlsplit(self.path)
        query = parse_qs(path.query)
        if path.path == "/healthz":
            self._send(200, {"ok": True, "service": "runtime"})
        elif path.path == "/whoami":
            self._send(200, {"ok": True, "service": "runtime"})
        elif path.path == "/users/tenant":
            self._send(200, {"user": query["user"][0], "tenant": "tenant-alice"})
        elif path.path == "/node/has":
            self._send(200, {"node": query["node"][0], "found": query["node"][0] in {"webui", "history"}})
        elif path.path == "/node/output":
            self._send(200, {"node": query["node"][0], "output": "webui: http://127.0.0.1:8790\n"})
        elif path.path == "/sessions":
            self._send(200, {"nodes": [{"name": "webui"}]})
        else:
            self._send(404, {"error": "no route", "code": "not_found"})

    def do_POST(self) -> None:
        body = self._body()
        self._record(body)
        if not self._authorized():
            self._send(401, {"error": "unauthorized", "code": "unauthorized"})
            return
        path = urlsplit(self.path).path
        if path == "/users/create":
            self._send(201, {"user": body["user"], "home": "/tmp/alice", "state": "ready"})
        elif path == "/bus/launch":
            self._send(201, {"host": "127.0.0.1", "port": 8788, "url": "ws://127.0.0.1:8788", "token": "bus-token", "pid": 42, "state": "running"})
        elif path == "/node/launch":
            self._send(201, {"name": body["node"], "version": "1.0.0", "dir": "/nodes/webui", "pid": 43, "state": "running"})
        elif path == "/connect":
            self._send(200, {"user": body["user"], "name": body["node"], "version": "1.0.0", "dir": "/nodes/webui", "pid": 43, "running": True})
        elif path in {"/bus/stop", "/node/stop", "/disconnect", "/users/destroy"}:
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "no route", "code": "not_found"})


class ClientTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        Handler.records.clear()

    async def test_refusals_keep_status_and_code(self) -> None:
        with self.assertRaises(RuntimeError) as caught:
            await AsyncRuntimeClient(self.url, "wrong-token").whoami()
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(caught.exception.code, "unauthorized")

    async def test_async_client_covers_the_runtime_contract(self) -> None:
        client = AsyncRuntimeClient(self.url, "test-token")
        self.assertEqual((await client.healthz())["service"], "runtime")
        user = await client.create_user("alice")
        self.assertEqual(user.home, "/tmp/alice")
        bus = await client.launch_bus()
        self.assertEqual(bus.token, "bus-token")
        node = await client.launch_node("webui")
        self.assertEqual(node.name, "webui")
        self.assertTrue(await client.has_node("webui"))
        self.assertFalse(await client.has_node("not-a-node"))
        self.assertIn("webui:", await client.output("webui") or "")
        self.assertEqual(await client.tenant("alice"), "tenant-alice")
        self.assertEqual((await client.connect("alice", "webui")).name, "webui")
        self.assertEqual((await client.sessions("alice"))["nodes"][0]["name"], "webui")
        await client.disconnect("alice", "webui")
        await node.stop()
        await bus.stop()
        self.assertIn("POST /node/launch", [f"{m} {p}" for m, p, _, _ in Handler.records])


if __name__ == "__main__":
    unittest.main()
