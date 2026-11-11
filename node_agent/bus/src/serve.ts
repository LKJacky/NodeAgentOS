#!/usr/bin/env node
// node-agent-bus: the bus as its own process, with no node of its own on it.
//
// The meta package's entry starts the bus and the agent together, which is what a self-contained
// demo wants. This one is for the other case: something else brings the nodes — python ones, a test,
// another machine — and all they need is somewhere to meet. It imports the bus package and nothing
// else, so it cannot drag a node in by accident.
//
// Once it is listening it prints exactly one line
//
//     bus: 127.0.0.1:<port>
//
// (for a human watching the console; anything that has to find this bus is told the port through
// NODE_AGENT_BUS_PORT instead — nothing parses this output), then serves until it is stopped.
//
//   node-agent-bus --url ws://127.0.0.1:8788 --token demo-token
//   node-agent-bus --url ws://0.0.0.0:8788 --token demo-token    reachable from another container
//   node-agent-bus                                             unpinned: the OS picks, and the
//                                                              printed line says which port it got
//
// The same two flags every entry takes; NODE_AGENT_BUS_URL / NODE_AGENT_TOKEN still work for a
// container that would rather be told with the environment. NODE_AGENT_CONTROL_TOKEN is the
// supervisor's credential, not a node's: a connection that presents it may change a user table,
// and a node connection that does not is refused, whatever kind of node it is.
//
// Stopping: SIGINT / SIGTERM, or end of stdin (so a supervisor that closes the pipe shuts it down
// the same way Ctrl-C would). A pinned port that is already taken is one line on stderr and exit 1
// — never a stack trace.
import { fstatSync } from 'node:fs';

import { Bus, busArgsOrExit } from './index.js';

/** What this entry was told: --url / --token, else the environment. When --url names where to
 *  listen, that is the address; without it NODE_AGENT_BUS_BIND / NODE_AGENT_BUS_PORT do, exactly as
 *  a container has always told it (0 = let the OS pick a port). */
const ARGS = busArgsOrExit('node-agent-bus', { ownsBus: true });
const PORT = ARGS.bind?.port ?? Number(process.env.NODE_AGENT_BUS_PORT ?? 0);
const BIND = ARGS.bind?.host ?? process.env.NODE_AGENT_BUS_BIND ?? '127.0.0.1';

/** Whether fd is a pipe: the only stdin whose end means "stop". */
function isPipe(fd: number): boolean {
  try {
    return fstatSync(fd).isFIFO() || fstatSync(fd).isSocket();
  } catch {
    return false;
  }
}

/** Resolve when this process should stop: a signal from its supervisor, Ctrl-C in a terminal, or
 *  end of stdin. The bus has to stay up until then — that is the whole job of a server. */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());

    // A piped stdin that is closed is how a parent says "stop"; a terminal waits for Ctrl-C. A
    // detached process gets /dev/null, where a read gives EOF at once - that is the absence of a
    // supervisor, not an instruction from one, and treating it as one ended this bus the moment
    // the stack that needed it started it (the trap the other entries' untilStopped() notes).
    if (!process.stdin.isTTY && isPipe(0)) {
      process.stdin.resume();
      process.stdin.once('end', () => resolve());
    }
  });
}

async function main(): Promise<void> {
  // The supervisor's credential: a bus started without it has no control connection at all.
  const controlToken = process.env.NODE_AGENT_CONTROL_TOKEN ?? '';
  let bus: Bus;
  try {
    bus = await new Bus(ARGS.token, controlToken, {
      permissions: { enforce: process.env.NODE_AGENT_BUS_PERMISSIONS_ENFORCE !== '0' },
    }).listen(PORT, BIND);
  } catch (e: unknown) {
    // The one failure a user causes by leaving an old run around, so answer it with a line.
    console.error(
      `bus failed to start (${BIND}:${PORT}): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }

  try {
    console.log(`bus: ${BIND}:${bus.port}`);

    await untilStopped();
  } finally {
    bus.close();
  }
}

await main();

// main's finally closed the bus, but a client socket that is still open would keep the event loop
// alive. This process exists to be started and stopped by a supervisor, so once its job is done it
// leaves — that is what makes "close stdin, then SIGTERM" a reliable way to stop it.
process.exit(0);
