// What a tool call does: the three bus tools, the two cache tools, the question only a person can
// answer, and - on a root agent - the two that start and stop a sub-agent. A tool answer is text: a
// node may answer with any JSON, and the model reads text.
import type { BindingScope, CapabilityEntry } from '@node-agent/sdk';
import type { Cache } from './cache.js';
import { asText } from './helpers.js';
import { agentNameOf } from './names.js';
import { ASK_USER_TOOL, SPAWN_TOOLS, TOOLS } from './tools.js';
import type { ToolCall, ToolSpec } from './types.js';

/** The agent a call names in its `agent` argument, or '' when it names none. */
function agentNamed(args: Record<string, unknown>): string {
  return typeof args.agent === 'string' ? agentNameOf(args.agent.trim()) : '';
}

/** Whether a capability takes an `agent` argument: the only ones a call can aim at one agent. */
function takesAgent(entry: UsableEntry): boolean {
  const schema = entry.parameters as { properties?: Record<string, unknown> };
  return schema.properties !== undefined && Object.hasOwn(schema.properties, 'agent');
}

/** One line of the bus directory, as the model is shown it. */
export type UsableEntry = {
  node: string;
  /** The capability's local name on that node, e.g. `chat`; `run_on_node` takes it as `tool_name`. */
  tool: string;
  desc: string;
  parameters: Record<string, unknown>;
};

/** What a stopped turn's tool call answers with: the model reads it as text like any other result. */
export const CANCELLED = 'cancelled by user';

/** Wait for `wait`, but answer at once when `signal` aborts. A node's tool may have no way to be
 *  cancelled, and a stopped turn must not go on waiting for it: the call keeps running behind the
 *  answer, and whatever it says later is dropped. */
async function untilAborted<T>(
  wait: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | string> {
  if (signal === undefined) return await wait;
  if (signal.aborted) {
    void wait.catch(() => {});
    return CANCELLED;
  }
  return await new Promise<T | string>((resolve, reject) => {
    const stop = (): void => resolve(CANCELLED);
    signal.addEventListener('abort', stop, { once: true });
    wait.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** What the environment needs from the runtime it belongs to. */
export interface EnvHost {
  /** The bus name the whole family shares: one tenant registers one identity, so the node the
   *  directory lists for this agent is the node every agent of the family runs on. */
  readonly busName?: string;
  /** The name this agent answers to in an `agent` argument: the root's own name for the main agent,
   *  the sub-agent's for a child. It is what a call may not name, because that would be the agent
   *  the call is already for. */
  readonly selfName?: string;
  readonly bus: BindingScope;
  readonly cache: Cache;
  /** Put a question in front of the reader and wait; answers the tool's text. */
  ask(callId: string | undefined, args: Record<string, unknown>): Promise<string>;
  /** Start / stop a sub-agent; a host that cannot is why the tools are not offered. */
  spawnAgent?(name: string, icon?: string, provider?: string): Promise<string>;
  destroyAgent?(name: string): Promise<string>;
}

export class AgentBusEnv {
  readonly host: EnvHost;
  readonly tools: ToolSpec[];

  constructor(host: EnvHost, options: { allowAskUser?: boolean; allowSpawn?: boolean } = {}) {
    this.host = host;
    this.tools = [...TOOLS];
    if (options.allowAskUser ?? true) this.tools.push(ASK_USER_TOOL);
    if ((options.allowSpawn ?? false) && this.host.spawnAgent !== undefined) {
      this.tools.push(...SPAWN_TOOLS);
    }
  }

  /** Whether a bus node is this agent itself: one tenant registers one identity, so the node under
   *  the family's name is the one every agent of the family answers on - a sub-agent included. */
  #isOwn(name: string): boolean {
    return name === (this.host.busName ?? '');
  }

  /** What one bus node answers that the model may call: its own list, minus the page and minus the
   *  bus's own policy fields (`callers`, `expose`), which are not part of a tool's schema. A node
   *  that is silent - gone, or refusing - answers nothing, which is also how it drops out of
   *  `list_nodes`. */
  async #capsOf(name: string): Promise<CapabilityEntry[]> {
    let caps;
    try {
      caps = await this.host.bus.listCapabilities(name);
    } catch {
      return [];
    }
    const shown: CapabilityEntry[] = [];
    for (const cap of caps) {
      if (cap.cap === 'ui') continue;
      const {
        callers: _callers,
        expose,
        ...parameters
      } = cap.parameters as {
        callers?: unknown;
        expose?: unknown;
      };
      if (expose === false) continue;
      shown.push({ cap: cap.cap, parameters: parameters as CapabilityEntry['parameters'] });
    }
    return shown;
  }

  /** One entry per capability the model may call: the bus directory filtered to what each node
   *  answers. The family's own registration is among them - its capabilities take an `agent`
   *  argument to name a sub-agent, which is how one is reached. */
  async usable(): Promise<UsableEntry[]> {
    const entries: UsableEntry[] = [];
    // What the agent answers to itself, kept apart: it goes after the bus, so a walk over the
    // usable nodes opens with what the agent is here to call and ends with its own work.
    const own: UsableEntry[] = [];
    for (const node of await this.host.bus.listNodes()) {
      if (node.name === 'history') continue;
      const mine = this.#isOwn(node.name);
      for (const cap of await this.#capsOf(node.name)) {
        const entry: UsableEntry = {
          node: node.name,
          tool: cap.cap,
          desc: node.desc,
          parameters: cap.parameters as Record<string, unknown>,
        };
        (mine ? own : entries).push(entry);
      }
    }
    return [...entries, ...own];
  }

  /** Run one tool call the model asked for, and answer the text its result becomes. `signal` is the
   *  turn's: once it aborts, the call is answered early rather than waited on. */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) return CANCELLED;
    const name = call.function.name;
    const raw = call.function.arguments;
    let args: unknown;
    try {
      args = JSON.parse(raw === '' ? '{}' : raw);
    } catch {
      return `arguments are not valid JSON: ${raw}`;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return `arguments are not valid JSON: ${raw}`;
    }
    const toolArgs = args as Record<string, unknown>;

    if (name === 'list_nodes') return await this.listNodes();
    if (name === 'list_node_tools') return await this.listNodeTools(toolArgs);
    if (name === 'run_on_node') return await this.runOnNode(toolArgs, signal);
    if (name === 'read_cache') return await this.readCache(toolArgs);
    if (name === 'search_cache') return await this.searchCache(toolArgs);
    if (name === 'ask_user') return await untilAborted(this.host.ask(call.id, toolArgs), signal);
    if (name === 'create_agent') return await this.createAgent(toolArgs);
    if (name === 'destroy_agent') return await this.destroyAgent(toolArgs);
    return `no such tool: ${name}`;
  }

  async createAgent(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    if (name === '') return 'create_agent needs a "name"';
    // Its tab has to be told apart from the others, so the drawing is part of creating one - not a
    // nicety a model may leave out and the page then has to invent.
    const icon = typeof args.icon === 'string' ? args.icon.trim() : '';
    if (icon === '') {
      return 'create_agent needs an "icon": the tab drawing as one <svg>...</svg> of SVG source';
    }
    const spawn = this.host.spawnAgent;
    if (spawn === undefined) return 'this agent cannot create sub-agents';
    try {
      const provider = typeof args.provider === 'string' ? args.provider : undefined;
      return await spawn.call(this.host, name, icon, provider);
    } catch (error) {
      return `cannot create "${name}": ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async destroyAgent(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '').trim();
    if (name === '') return 'destroy_agent needs a "name"';
    const destroy = this.host.destroyAgent;
    if (destroy === undefined) return 'this agent cannot destroy sub-agents';
    try {
      return await destroy.call(this.host, name);
    } catch (error) {
      return `cannot destroy "${name}": ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Every node this agent can reach, read straight off the bus and filtered to what the model may
   *  call, in the order it should look at them: the bus first, and this agent itself last. */
  async listNodes(): Promise<string> {
    const names: string[] = [];
    const mine: string[] = [];
    for (const node of await this.host.bus.listNodes()) {
      if (node.name === 'history') continue;
      // A node with nothing the model could call is not a node to it.
      if ((await this.#capsOf(node.name)).length === 0) continue;
      (this.#isOwn(node.name) ? mine : names).push(node.name);
    }
    const ordered = [...names, ...mine];
    if (ordered.length === 0) return 'no usable nodes on the bus';
    return ordered.map((name) => `- ${name}`).join('\n');
  }

  async listNodeTools(args: Record<string, unknown>): Promise<string> {
    const node = String(args.node ?? '');
    const entries = (await this.usable()).filter((entry) => entry.node === node);
    if (entries.length === 0) {
      return `no usable node "${node}" (use list_nodes to see what is there)`;
    }
    const lines: string[] = [];
    for (const entry of entries) {
      const schema = { ...entry.parameters };
      const description = schema.description;
      delete schema.description;
      const label = typeof description === 'string' ? description : entry.desc;
      lines.push(`${entry.tool}: ${label ?? ''}\n  parameters: ${JSON.stringify(schema)}`);
    }
    return lines.join('\n');
  }

  /** One capability call on one node. `signal` is the turn's: a node that does not answer is left
   *  behind, with the tool's text saying so. */
  async runOnNode(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const node = String(args.node ?? '');
    const tool = String(args.tool_name ?? '');
    const address = `${node}.${tool}`;
    const entry = (await this.usable()).find((row) => row.node === node && row.tool === tool);
    if (entry === undefined) {
      return `cannot call "${address}": not in the usable list (check list_nodes / list_node_tools)`;
    }
    const toolArgs = args.tool_args;
    const passed =
      typeof toolArgs === 'object' && toolArgs !== null && !Array.isArray(toolArgs)
        ? (toolArgs as Record<string, unknown>)
        : {};
    try {
      // An agent is called like every other node: the frame goes on the bus and the node answers
      // it. The one thing this family refuses is a call that would act on the agent making it -
      // naming a sub-agent hands it a turn, naming itself would wait for the turn in progress
      // (`chat`) or cut it (`stop`).
      if (node === this.host.busName && takesAgent(entry)) {
        const self = this.host.selfName ?? '';
        const named = agentNamed(passed);
        if (named === self) {
          throw new Error(
            `cannot name "${self}" in "agent": an agent does not act on itself - name one of ` +
              'its sub-agents',
          );
        }
        if (
          named === '' &&
          self === (this.host.busName ?? '') &&
          (tool === 'chat' || tool === 'stop')
        ) {
          throw new Error(
            tool === 'chat'
              ? 'this agent cannot chat with itself: the turn would wait for the turn that is asking'
              : 'this agent cannot stop itself: that would cut the turn that is asking',
          );
        }
      }
      const value = await untilAborted(this.host.bus.call(node, tool, passed), signal);
      return asText(value);
    } catch (error) {
      return `tool call failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async readCache(args: Record<string, unknown>): Promise<string> {
    const entry = args.entry;
    const start = args.start ?? 0;
    const length = args.length ?? null;
    if (entry === undefined || entry === null) {
      return 'entry is required: the cache warning names the number to read';
    }
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) {
      return 'entry must be an integer, the number the cache warning named';
    }
    if (typeof start !== 'number' || !Number.isSafeInteger(start)) {
      return 'start must be an integer offset into the text';
    }
    if (length !== null && (typeof length !== 'number' || !Number.isSafeInteger(length))) {
      return 'length must be an integer, or left out to read through the end';
    }
    const text = await this.host.cache.read(entry, start, length as number | null);
    if (text === null) {
      return `no cache entry ${entry}: it was never added or has already left the cache`;
    }
    return text;
  }

  async searchCache(args: Record<string, unknown>): Promise<string> {
    const entry = args.entry;
    const pattern = args.pattern;
    const context = args.context ?? 100;
    if (entry === undefined || entry === null) {
      return 'entry is required: the cache warning names the number to search';
    }
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) {
      return 'entry must be an integer, the number the cache warning named';
    }
    if (typeof pattern !== 'string' || pattern === '') {
      return 'pattern is required: the regular expression to search for';
    }
    if (typeof context !== 'number' || !Number.isSafeInteger(context)) {
      return 'context must be an integer number of characters';
    }
    try {
      const matches = await this.host.cache.search(entry, pattern, context);
      return asText(matches);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
