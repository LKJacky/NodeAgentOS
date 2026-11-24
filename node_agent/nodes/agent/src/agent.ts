// agent: the node that holds the model. It is the thin bus face of AgentFamily: the SDK builds one
// Node per invocation, and everything that must survive between calls (the main runtime, its
// sub-agents, transcript, queue, turn, usage) lives in the object `ctx.bind` keeps for that tenant.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  Node,
  loadResource,
  paintPage,
  requireBindings,
  type NodeContext,
  type NodeHandlers,
  type Resource,
  type ToolArgs,
} from '@node-agent/sdk';
import { CAPABILITY_NAMES, PACKAGE_ICON } from './manifest.js';
import { AgentFamily } from './family.js';
import { readHistory, readSubagentNames } from './history.js';
import { providerState } from './provider.js';
import { emptyUsage } from './helpers.js';
import type { AgentRuntime, AgentStatus, RuntimeOptions } from './runtime.js';
import { ConversationStateUnit } from './storage.js';
import type { Message } from './types.js';

/** The one capability name the browser front end agrees on: the page. (Which column that page lands in
 *  is the shell's decision, not the schema's: see `Panel` in webui/src/index.ts.) */
const PANEL = 'ui';

/** The key this package keeps its per-tenant runtime under. Declared in `node.bindings`; the host
 *  refuses any other key, and keeps one object per tenant. */
export const RUNTIME_BINDING = 'agent-runtime';

/** The capability names this node registers, in the manifest's order. */
export const CAPABILITIES = CAPABILITY_NAMES;

/** Read one asset beside this module: `src/` in a checkout, `dist/` in a package, both by the same
 *  relative path because the build copies them next door. */
export function readAsset(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

/** What the page gets when markdown-it is not installed: the same surface the page actually uses
 *  (`window.markdownit(...).use(plugin)` then `.render(text)`), rendering escaped plain text instead
 *  of Markdown. `use` is a no-op that hands the renderer back, the way markdown-it's own does. It is
 *  not optional: the page registers its plugins with `.use` on the first line that touches markdown,
 *  and without it that line throws and nothing after it runs — no transcript, no provider list, no
 *  token counters: just the dashes and "Loading providers…" the markup was born with. */
const PLAIN_TEXT_RENDERER = `window.markdownit=function(){var renderer={use:function(){return
renderer},render:function(source){var box=document.createElement('div');
box.textContent=source==null?'':String(source);return
box.innerHTML.replace(/\\n/g,'<br>');}};return renderer;};`;

/** Markdown and real formulas without requiring internet access or another HTTP route: markdown-it's
 *  own browser bundle, read from wherever this package was installed. Which file that is depends on
 *  the version: some publish `dist/markdown-it.min.js`, some only the unminified
 *  `dist/markdown-it.js` (this checkout is the second kind). Both define the same `window.markdownit`
 *  global when inlined in a `<script>`, so try the minified one first and take the readable one next.
 *  `index.cjs.js` is not a candidate: it is a CommonJS module and would throw on `module` in the page. */
function markdownRenderer(): string {
  const require = createRequire(import.meta.url);
  for (const at of ['markdown-it/dist/markdown-it.min.js', 'markdown-it/dist/markdown-it.js']) {
    try {
      return readFileSync(require.resolve(at), 'utf8');
    } catch {
      // Not in this copy of the package: the next candidate may be.
    }
  }
  // A checkout with no markdown-it (or one that ships neither browser bundle) still gets a page:
  // it renders escaped text. Never the package's CommonJS entry — that throws on `module` in a page.
  return PLAIN_TEXT_RENDERER;
}

let pageCache: string | null = null;

/** The page's words, read from beside the compiled module (`npm run build` copies `src/i18n` to
 *  `dist/i18n`, which is what `node.i18n` in package.json names). */
const RESOURCE: Resource = loadResource(new URL('./i18n/', import.meta.url));

/** The page, with the renderer inlined, this node's own name filled in where it hands it out, and the
 *  words of the visit's language written into its markers. A name belongs to whoever started the node,
 *  so the page cannot have it written in — and neither can the language, which is the reader's: `args`
 *  is the `ui` call, whose `language` is what `paintPage` draws the page in. */
export function page(name: string, args?: unknown): string {
  pageCache ??= readAsset('ui.html').replace('/*__MARKDOWN_IT__*/', () => markdownRenderer());
  return paintPage(pageCache, RESOURCE, args).replace('__NODE__', () =>
    JSON.stringify(name).slice(1, -1),
  );
}

export type AgentOptions = RuntimeOptions;

/**
 * The runtime this context keeps, made on first use and shared by every later call of the same
 * tenant.
 *
 * `ctx.bind` is the storage: it is keyed by tenant inside the host, so two tenants never meet,
 * and it is the host that drops the objects when it stops. The factory runs inside one invocation,
 * so it reads the tenant and the name it is created for — and nothing else of that invocation is
 * kept: the transport is either the tenant's pinned session or the context bus that every handler
 * re-binds before it works.
 */
export function familyFor(ctx: NodeContext, options: AgentOptions = {}): AgentFamily {
  const bindings = requireBindings(ctx);
  // The factory gets the host's scope, never this invocation's context: the object it makes may
  // outlive the call (`chat_no_wait`) and still has to reach the bus when it does.
  return bindings.bind(RUNTIME_BINDING, (scope) => new AgentFamily({ scope, options }));
}

/** The main agent's runtime for this context. */
export function runtimeFor(ctx: NodeContext, options: AgentOptions = {}): AgentRuntime {
  return familyFor(ctx, options).main;
}

/** The one agent argument every capability takes: a sub-agent's name, or nothing for this node's
 *  own agent. */
function targetOf(args: ToolArgs): string {
  const value = args.agent;
  return typeof value === 'string' ? value.trim() : '';
}

/** The state a page shows before its agent is running: persisted usage, idle everywhere else. */
async function readStatus(ctx: NodeContext, prefix: string): Promise<AgentStatus> {
  let usage: unknown = undefined;
  try {
    const stateUnit = new ConversationStateUnit(ctx, `${prefix}conversation`);
    await stateUnit.load();
    usage = stateUnit.meta.usage;
  } catch {
    // No history node is a deployment with nothing written down: idle, and zero counts.
  }
  return {
    state: 'idle',
    queued: [],
    usage:
      typeof usage === 'object' && usage !== null
        ? { ...emptyUsage(), ...(usage as Record<string, number>) }
        : emptyUsage(),
    stream: null,
  };
}

export class AgentNode extends Node {
  readonly handlers: NodeHandlers;
  readonly #options: AgentOptions;

  constructor(ctx: NodeContext, options: AgentOptions = {}) {
    super(ctx);
    this.#options =
      options.icon === undefined && PACKAGE_ICON !== undefined
        ? { ...options, icon: PACKAGE_ICON }
        : options;
    this.handlers = {
      chat: (args: ToolArgs) => this.#chat(args),
      chat_no_wait: (args: ToolArgs) => this.#chatNoWait(args),
      history: async (args: ToolArgs) => {
        const target = targetOf(args);
        return await readHistory(this.ctx, await this.#prefixOf(target), args.from, args.count);
      },
      status: async (args: ToolArgs) => {
        const target = targetOf(args);
        const running = this.family.started(target);
        if (running !== undefined) return running.status();
        return await readStatus(this.ctx, await this.#prefixOf(target));
      },
      // The answer being written right now, as it stands, or `{stream: null}` between rounds. This is
      // the node's own read for its page - `expose: false`, like `ui` - so it is not offered to
      // sibling nodes or to the model as a tool. A page asks for it once when it has a gap in the
      // deltas to fill (a lost frame, a reconnected stream): the one call that carries the line so
      // far, and no token ever goes through it.
      stream: async (args: ToolArgs) => ({ stream: (await this.#target(args)).streamState() }),
      stop: async (args: ToolArgs) => this.#stop(args),
      provider: async (args: ToolArgs) =>
        await providerState(this.ctx, await this.#prefixOf(targetOf(args)), args.action, args.name),
      // What this agent runs on: the five numbers and the two switches its page may change. The settings of one agent
      // are its own - a sub-agent starts on its parent's and then keeps its own copy - so this is
      // answered by the agent the call names, like every other per-agent read.
      settings: async (args: ToolArgs) => (await this.#target(args)).handleSettings(args),
      answer: async (args: ToolArgs) => (await this.#target(args)).answer(args),
      // The agents this node runs, as `{agents: [...]}`: the main agent first, then the sub-agents
      // it started, each with the topic and state a page follows it by.
      agents: async () => ({ agents: (await this.#readyFamily()).rows() }),
      // Destroying a sub-agent is a capability, not only a tool the model can call: the page's tab
      // menu reaches it directly, so what a delete does is decided in one place (`AgentRuntime`)
      // rather than by whoever asks. The answer is the runtime's own sentence about what went.
      destroy_agent: async (args: ToolArgs) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name === '') throw new Error('destroy_agent needs a "name"');
        const family = await this.#readyFamily();
        if (name === family.main.name) throw new Error('the main agent cannot be destroyed');
        return await family.destroyAgent(name);
      },
      [PANEL]: async (args: ToolArgs) => page((await this.#ready()).identity.topic, args),
    };
  }

  /** The runtime of the invocation that is running now. Looked up through the current context every
   *  time, so a stateful host handing this instance a newer context is followed rather than
   *  ignored. */
  /** The family this tenant keeps: the main agent and every runtime it started. */
  get family(): AgentFamily {
    return familyFor(this.ctx, this.#options);
  }

  /** The main agent's runtime for this invocation. */
  get runtime(): AgentRuntime {
    return this.family.main;
  }

  /** The unit prefix one named agent reads and writes, without starting it. */
  async #prefixOf(target: string): Promise<string> {
    if (target === '' || target === this.ctx.nodeId) return '';
    const names = await readSubagentNames(this.ctx);
    if (!names.includes(target)) {
      throw new Error(
        `no agent named "${target}" here (agents: ${[this.ctx.nodeId, ...names].join(', ')})`,
      );
    }
    return `sub.${target}.`;
  }

  /** The family for this invocation, ready. */
  async #readyFamily(): Promise<AgentFamily> {
    const family = this.family;
    await family.ready();
    return family;
  }

  /** The runtime for this invocation, ready. */
  async #ready(): Promise<AgentRuntime> {
    return (await this.#readyFamily()).main;
  }

  /** The agent one call is for: this node's own, or the sub-agent its `agent` names. */
  async #target(args: ToolArgs): Promise<AgentRuntime> {
    const family = await this.#readyFamily();
    return await family.ensureAgent(targetOf(args));
  }

  async #chat(args: ToolArgs): Promise<Message[]> {
    const runtime = await this.#target(args);
    return await runtime.chat(
      args.msg ?? {},
      { from: this.ctx.from, deadline: this.ctx.deadline },
      args.priority,
    );
  }

  async #chatNoWait(args: ToolArgs): Promise<string> {
    const runtime = await this.#target(args);
    return await runtime.chatNoWait(
      args.msg ?? {},
      { from: this.ctx.from, deadline: this.ctx.deadline },
      args.priority,
    );
  }

  /** Cut the turn that is running short. One agent's button stops that agent's turn and nothing else:
   *  the sub-agents it started keep theirs, the lines queued behind it are turns of their own and run
   *  as they would have, and the runtime itself is left alone - keeping one is the host's business, and
   *  not something a Stop has an opinion about. A sub-agent's stop answers for that agent in the same
   *  way; a name that is not in this family is refused by `agent()`. */
  async #stop(args: ToolArgs): Promise<string> {
    const family = await this.#readyFamily();
    return await (await family.ensureAgent(targetOf(args))).stop();
  }

  /** Provider stream chunks, delivered to this tenant's runtime hub by request id. */
  override onEvent(topic: string, value: unknown): void {
    this.runtime.handleEvent(topic, value);
  }
}

export default AgentNode;
