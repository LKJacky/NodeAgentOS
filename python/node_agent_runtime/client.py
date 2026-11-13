"""An async Python client for the NodeAgent runtime HTTP API.

The TypeScript side has ``RuntimeClient`` in ``runtime/src/client.ts``; this file answers the same
routes. It uses only the standard library: each blocking HTTP request runs in
``asyncio.to_thread`` so the event loop stays free while the runtime starts a process.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping

Json = dict[str, Any]
AsyncStop = Callable[[], Awaitable[None]]


class RuntimeError(Exception):
    """The runtime refused a request, or could not be reached.

    ``status`` is the HTTP status when there was an answer; ``code`` is the runtime's stable error
    code (for example ``invalid_node`` or ``node_start_failed``).
    """

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class UserHandle:
    user: str
    home: str
    state: str


@dataclass(frozen=True)
class AsyncBusHandle:
    host: str
    port: int
    url: str
    token: str
    pid: int | None
    state: str
    _stop: AsyncStop = field(repr=False, compare=False)

    async def stop(self) -> None:
        await self._stop()


@dataclass(frozen=True)
class AsyncNodeHandle:
    name: str
    version: str
    dir: str
    pid: int | None
    state: str
    _stop: AsyncStop = field(repr=False, compare=False)

    async def stop(self) -> None:
        await self._stop()


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _state(view: Mapping[str, Any]) -> str:
    state = view.get("state")
    if isinstance(state, str):
        return state
    return "running" if view.get("running") is True else "starting"


def _pid(view: Mapping[str, Any]) -> int | None:
    pid = view.get("pid")
    return pid if isinstance(pid, int) else None


class AsyncRuntimeClient:
    """The runtime HTTP API with ``async`` methods.

    ``url`` is what the server printed, e.g. ``http://127.0.0.1:8793``. ``token`` is the service
    token passed to ``RuntimeServer``. The client owns no process table: every method is one HTTP
    request, and every refusal keeps the server's status and code.
    """

    def __init__(
        self,
        url: str,
        token: str = "",
        *,
        timeout: float = 10.0,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        address = url.strip().rstrip("/")
        if not address:
            raise ValueError("a runtime client needs an address")
        self.url = address
        self.token = token.strip()
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    async def close(self) -> None:
        """Nothing to release; kept so callers can use one shutdown shape."""

    async def _run(self, function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(function, *args, **kwargs)

    def _request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> Any:
        headers = {"accept": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(
            self.url + path, data=data, headers=headers, method=method
        )
        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8")
            parsed: Mapping[str, Any] = {}
            try:
                value = json.loads(raw) if raw else {}
                if isinstance(value, dict):
                    parsed = value
            except ValueError:
                pass
            message = parsed.get("error")
            code = parsed.get("code")
            raise RuntimeError(
                message if isinstance(message, str) else f"runtime answered {error.code}",
                status=error.code,
                code=code if isinstance(code, str) else None,
            ) from None
        except (TimeoutError, OSError, urllib.error.URLError) as error:
            raise RuntimeError(
                f"the runtime at {self.url} is not answering: {error}",
                code="runtime_unavailable",
            ) from None
        if raw == "":
            return {}
        try:
            value = json.loads(raw)
        except ValueError:
            raise RuntimeError("runtime answered with non-JSON", code="internal") from None
        return value

    async def healthz(self) -> Json:
        return await self._run(self._request, "GET", "/healthz")

    async def whoami(self) -> Json:
        return await self._run(self._request, "GET", "/whoami")

    async def create_user(self, user: str) -> UserHandle:
        view = await self._run(self._request, "POST", "/users/create", {"user": user})
        return UserHandle(
            user=str(view.get("user", user)),
            home=str(view.get("home", "")),
            state=str(view.get("state", "ready")),
        )

    async def destroy_user(self, user: str) -> None:
        await self._run(self._request, "POST", "/users/destroy", {"user": user})

    async def tenant(self, user: str) -> str:
        view = await self._run(self._request, "GET", f"/users/tenant?user={_quote(user)}")
        tenant = view.get("tenant")
        return tenant if isinstance(tenant, str) else ""

    async def launch_bus(self, options: Mapping[str, Any] | None = None) -> AsyncBusHandle:
        view = await self._run(
            self._request, "POST", "/bus/launch", {"options": dict(options or {})}
        )
        return AsyncBusHandle(
            host=str(view.get("host", "")),
            port=int(view.get("port", 0)),
            url=str(view.get("url", "")),
            token=str(view.get("token", "")),
            pid=_pid(view),
            state=_state(view),
            _stop=self.stop_bus,
        )

    async def stop_bus(self) -> None:
        await self._run(self._request, "POST", "/bus/stop", None)

    async def launch_node(
        self, node: str, options: Mapping[str, Any] | None = None
    ) -> AsyncNodeHandle:
        view = await self._run(
            self._request, "POST", "/node/launch", {"node": node, "options": dict(options or {})}
        )
        return self._node(view)

    async def stop_node(self, node: str) -> None:
        await self._run(self._request, "POST", "/node/stop", {"node": node})

    async def has_node(self, node: str) -> bool:
        view = await self._run(self._request, "GET", f"/node/has?node={_quote(node)}")
        return view.get("found") is True

    async def output(self, node: str) -> str | None:
        view = await self._run(self._request, "GET", f"/node/output?node={_quote(node)}")
        output = view.get("output")
        return output if isinstance(output, str) else None

    async def connect(
        self, user: str, node: str, options: Mapping[str, Any] | None = None
    ) -> AsyncNodeHandle:
        view = await self._run(
            self._request,
            "POST",
            "/connect",
            {"user": user, "node": node, "options": dict(options or {})},
        )
        return self._node(view)

    async def disconnect(self, user: str, node: str) -> None:
        await self._run(self._request, "POST", "/disconnect", {"user": user, "node": node})

    async def sessions(self, user: str | None = None) -> Json:
        path = "/sessions"
        if user is not None:
            path += "?" + urllib.parse.urlencode({"user": user})
        return await self._run(self._request, "GET", path)

    def _node(self, view: Mapping[str, Any]) -> AsyncNodeHandle:
        name = str(view.get("name", ""))
        return AsyncNodeHandle(
            name=name,
            version=str(view.get("version", "")),
            dir=str(view.get("dir", "")),
            pid=_pid(view),
            state=_state(view),
            _stop=lambda: self.stop_node(name),
        )
