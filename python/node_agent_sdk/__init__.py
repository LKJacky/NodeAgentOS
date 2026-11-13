"""The small NodeAgent bus SDK for Python: connect, implement a stateless node, call and list."""

from .bus import BusClient, BusError
from .host import Host
from .node import CallContext, Node, NodeContext


def __getattr__(name: str):
    if name in {"RunningNode", "RuntimeProcess", "launch_node", "launch_node_agent"}:
        from . import serve

        return getattr(serve, name)
    raise AttributeError(name)


__all__ = [
    "BusClient",
    "BusError",
    "CallContext",
    "Host",
    "Node",
    "NodeContext",
    "RunningNode",
    "RuntimeProcess",
    "launch_node",
    "launch_node_agent",
]
