# Security

## Reporting

Do not open a public issue for a vulnerability. Mail the maintainer listed in the repository profile,
or open a private security advisory on GitHub. Please include what you ran, what happened, and what you
expected; a minimal reproduction is worth more than a report.

There is no bounty, no SLA and no support contract. This is a personal project.

## What the design assumes

- **One user, one token.** `NODE_AGENT_TOKEN` authorizes a node to join the bus; the built-in door
  (`NODE_AGENT_ACCESS_TOKEN`) is what a browser off this machine gets through, and its cookie is a
  hash of that second token. Rotating either revokes everything that used it (restart the stack).
- **Loopback by default.** The bus and the Web UI bind `127.0.0.1` unless you widen them. Widening them
  without a token is a misconfiguration, not a vulnerability.
- **The shell node is a shell.** It runs commands as the user that started it, in
  `NODE_AGENT_WORKSPACE`. It is not a sandbox and does not pretend to be one; if you need isolation,
  run the stack in a container and keep the workspace volume small.
- **The model sees what you send it.** Conversations, file contents the agent reads and command output
  it observes leave your machine for whatever endpoint `NODE_AGENT_MODEL_URL` names. Use a local
  endpoint if that matters to you.
- **Not collected:** no telemetry, no crash reports, no usage data.

## Scope

In scope: the bus's authentication, node registration, the runtime's process handling, path handling
in the shell node, and the built-in door in `node_agent/node-agent` (`NODE_AGENT_ACCESS_TOKEN`).

Out of scope: anything you exposed to the internet without a token (the `public` profile without
`NODE_AGENT_ACCESS_TOKEN` included), a model provider's own behaviour, and third-party nodes you
installed.
