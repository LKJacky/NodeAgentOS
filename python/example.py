#!/usr/bin/env python3
"""A small end-to-end Python SDK example.

It starts @node-agent/local, prints the runtime, bus and web UI addresses, then waits until Ctrl-C.

    python python/example.py
"""

from __future__ import annotations

import asyncio
import os
import random
import shutil
import sys
import tempfile
from pathlib import Path

NODE_AGENT_SUPER_TOKEN = random.randint(0, 2**64 - 1)
os.environ.setdefault("NODE_AGENT_SUPER_TOKEN", str(NODE_AGENT_SUPER_TOKEN))
os.environ.setdefault("NODE_AGENT_WEBUI_PORT", str(8000))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from node_agent_sdk import launch_node_agent  # noqa: E402


async def main() -> int:
    home = tempfile.mkdtemp(prefix="node-agent-python-example-")
    runtime = None
    try:
        runtime = await launch_node_agent(
            home=home,
            command=os.environ.get("NODE_AGENT_COMMAND"),
            timeout=60,
            nodes=[],
        )
        print(f"runtime: {runtime.runtime_url}")
        print(f"bus:     {runtime.bus_url}")
        print(f"webui:   {runtime.webui_url}")
        await asyncio.Event().wait()
    finally:
        if runtime is not None:
            await runtime.stop()
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
