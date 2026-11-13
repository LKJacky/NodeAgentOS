"""The async Python client for the NodeAgent runtime HTTP API."""

from .client import AsyncBusHandle, AsyncNodeHandle, AsyncRuntimeClient, RuntimeError, UserHandle


def __getattr__(name: str):
    if name == "RuntimeNode":
        from .runtime_node import RuntimeNode

        return RuntimeNode
    raise AttributeError(name)


__all__ = [
    "AsyncBusHandle",
    "AsyncNodeHandle",
    "AsyncRuntimeClient",
    "RuntimeError",
    "RuntimeNode",
    "UserHandle",
]
