"""Launch the NodeAgent runtime, and launch one Python node on its bus.

This is the Python equivalent of the small ``serve`` entry points: ``launch_runtime`` starts the
NodeAgent process and returns its runtime/bus/webui addresses; ``launch_node`` starts a
``Node`` class through ``Host`` and waits until it has registered.

    runtime = await launch_runtime(home="/tmp/na")
    node = await launch_node(Echo, runtime.bus_url, runtime.bus_token)
    ...
    await node.stop()
    await runtime.stop()
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import os
import secrets
import shlex
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .host import Host
from .node import Node


@dataclass
class RuntimeProcess:
    """A running NodeAgent runtime; ``stop`` terminates it and cleans an owned home."""

    process: asyncio.subprocess.Process
    runtime_url: str
    runtime_token: str
    bus_url: str
    bus_token: str
    webui_url: str | None
    home: str
    cwd: str
    lines: list[str] = field(repr=False, default_factory=list)
    _owned_home: bool = field(repr=False, default=False)
    _reader: asyncio.Task[None] | None = field(repr=False, default=None)

    async def stop(self) -> None:
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=10)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
        if self._owned_home:
            shutil.rmtree(self.home, ignore_errors=True)

    async def __aenter__(self) -> "RuntimeProcess":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.stop()


@dataclass
class RunningNode:
    """A Python node registered by ``Host``."""

    host: Host
    task: asyncio.Task[None] = field(repr=False)

    @property
    def name(self) -> str:
        return self.host.name

    async def stop(self) -> None:
        await self.host.stop()
        self.task.cancel()
        try:
            await self.task
        except (asyncio.CancelledError, Exception):
            pass

    async def wait(self) -> None:
        await self.task

    async def __aenter__(self) -> "RunningNode":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.stop()


def _root(root: str | Path | None, *, require_serve: bool = True) -> Path:
    candidate = Path(root or os.environ.get("NODE_AGENT_ROOT") or Path(__file__).resolve().parents[2])
    serve = candidate / "node_agent" / "node-agent" / "dist" / "serve.js"
    if require_serve and not serve.exists():
        raise RuntimeError(f"cannot find {serve}; pass root= or set NODE_AGENT_ROOT/NODE_AGENT_SERVE")
    return candidate


def _bus_url(value: str) -> str:
    value = value.strip()
    if "://" in value:
        return value
    return f"ws://{value}"


async def _wait_line(lines: list[str], prefix: str, process: asyncio.subprocess.Process, timeout: float) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        for line in list(lines):
            if line.startswith(prefix):
                return line.split(prefix, 1)[1].strip()
        if process.returncode is not None:
            raise RuntimeError(f"node-agent exited before {prefix!r} (code {process.returncode})")
        await asyncio.sleep(0.05)
    raise RuntimeError(f"node-agent did not print {prefix!r} within {timeout:.0f}s")


async def launch_runtime(
    *,
    root: str | Path | None = None,
    home: str | Path | None = None,
    runtime_token: str | None = None,
    bus_token: str | None = None,
    user: str = "default",
    nodes: Sequence[str] | str | None = None,
    timeout: float = 60.0,
    env: Mapping[str, str] | None = None,
    command: Sequence[str] | str | None = None,
    echo: bool = False,
) -> RuntimeProcess:
    """Start the NodeAgent runtime and wait until its addresses are known.

    ``command`` overrides the executable (for a wrapper or a bundled install). The default is
    ``node <root>/node_agent/node-agent/dist/serve.js``.
    """
    cwd = _root(root, require_serve=command is None)
    serve = os.environ.get("NODE_AGENT_SERVE") or str(cwd / "node_agent" / "node-agent" / "dist" / "serve.js")
    if isinstance(command, str):
        argv = shlex.split(command)
    elif command is not None:
        argv = list(command)
    else:
        argv = [os.environ.get("NODE_AGENT_NODE", "node"), serve]

    owned_home = home is None
    home_path = Path(home) if home is not None else Path(tempfile.mkdtemp(prefix="node-agent-"))
    home_path.mkdir(parents=True, exist_ok=True)
    runtime_token = runtime_token or secrets.token_hex(24)
    bus_token = bus_token or secrets.token_hex(24)

    child_env = {
        **os.environ,
        **dict(env or {}),
        "NODE_AGENT_HOME": str(home_path),
        "NODE_AGENT_BUS_PORT": "0",
        "NODE_AGENT_RUNTIME_PORT": "0",
        "NODE_AGENT_WEBUI_PORT": "0",
        "NODE_AGENT_RUNTIME_SERVICE_TOKEN": runtime_token,
        "NODE_AGENT_TOKEN": bus_token,
        "NODE_AGENT_USER": user,
    }
    if nodes is not None:
        child_env["NODE_AGENT_NODES"] = nodes if isinstance(nodes, str) else ",".join(nodes)

    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=child_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    lines: list[str] = []

    async def read() -> None:
        assert process.stdout is not None
        while True:
            raw = await process.stdout.readline()
            if raw == b"":
                return
            line = raw.decode("utf-8", "replace").rstrip("\n")
            lines.append(line)
            if echo:
                print(f"[node-agent] {line}", flush=True)

    reader = asyncio.create_task(read())
    try:
        runtime_url = await _wait_line(lines, "runtime: ", process, timeout)
        bus_line = await _wait_line(lines, "bus: ", process, timeout)
        await _wait_line(lines, "Ready to connect", process, timeout)
    except Exception:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        reader.cancel()
        if owned_home:
            shutil.rmtree(home_path, ignore_errors=True)
        raise

    webui_url: str | None = None
    for line in lines:
        if line.startswith("webui: "):
            webui_url = line.split("webui: ", 1)[1].strip()
    return RuntimeProcess(
        process=process,
        runtime_url=runtime_url,
        runtime_token=runtime_token,
        bus_url=_bus_url(bus_line),
        bus_token=bus_token,
        webui_url=webui_url,
        home=str(home_path),
        cwd=str(cwd),
        lines=lines,
        _owned_home=owned_home,
        _reader=reader,
    )


async def launch_node(
    node_class: type[Node],
    bus_url: str,
    bus_token: str = "",
    *,
    name: str | None = None,
    node_kwargs: Mapping[str, Any] | None = None,
    timeout: float = 30.0,
) -> RunningNode:
    """Start one Python node and wait until its manifest is registered."""
    host = Host(
        node_class,
        bus_url,
        bus_token,
        name=name,
        node_kwargs=node_kwargs,
        timeout=timeout,
    )
    task = asyncio.create_task(host.run())
    try:
        await asyncio.wait_for(host.ready.wait(), timeout=timeout)
    except Exception:
        await host.stop()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        raise
    return RunningNode(host=host, task=task)


def _load_node(spec: str) -> type[Node]:
    module_name, separator, class_name = spec.partition(":")
    if not separator or not module_name or not class_name:
        raise SystemExit("node must be module:Class")
    module = importlib.import_module(module_name)
    value = getattr(module, class_name)
    if not isinstance(value, type) or not issubclass(value, Node):
        raise SystemExit(f"{spec} is not a Node class")
    return value


async def _runtime_main(args: argparse.Namespace) -> int:
    runtime = await launch_runtime(
        root=args.root,
        home=args.home,
        user=args.user,
        nodes=args.nodes,
        timeout=args.timeout,
        echo=True,
    )
    print(f"runtime: {runtime.runtime_url}")
    print(f"bus:     {runtime.bus_url}")
    if runtime.webui_url:
        print(f"webui:   {runtime.webui_url}")
    try:
        await asyncio.Event().wait()
    finally:
        await runtime.stop()
    return 0


async def _node_main(args: argparse.Namespace) -> int:
    node = await launch_node(
        _load_node(args.node),
        args.bus_url,
        args.bus_token,
        name=args.name,
        timeout=args.timeout,
    )
    print(f"node {node.name}: joined {args.bus_url}")
    try:
        await asyncio.Event().wait()
    finally:
        await node.stop()
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch a NodeAgent runtime or one Python node")
    sub = parser.add_subparsers(dest="what", required=True)

    runtime = sub.add_parser("runtime", help="start node-agent and its bus")
    runtime.add_argument("--root")
    runtime.add_argument("--home")
    runtime.add_argument("--user", default="default")
    runtime.add_argument("--nodes", help="comma-separated extra node packages")
    runtime.add_argument("--timeout", type=float, default=60.0)
    runtime.set_defaults(run=_runtime_main)

    node = sub.add_parser("node", help="start one Python Node class")
    node.add_argument("node", help="module:Class")
    node.add_argument("--bus-url", required=True)
    node.add_argument("--bus-token", default="")
    node.add_argument("--name")
    node.add_argument("--timeout", type=float, default=30.0)
    node.set_defaults(run=_node_main)

    args = parser.parse_args(argv)
    try:
        return asyncio.run(args.run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
