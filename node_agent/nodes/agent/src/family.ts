// One agent's family: the main runtime and every runtime it started. A runtime is one agent; the
// family is the shared identity, the hub every runtime streams through, and the one place the
// sub-agent list is stored and restored.
import type { BindingScope } from '@node-agent/sdk';
import { agentLog } from './log.js';
import { agentNameOf } from './names.js';
import { AgentRuntime, type AgentRow, type RuntimeOptions } from './runtime.js';
import { StreamHub } from './model.js';
import { subagentsStorage, type StoredAgent } from './storage.js';

/** Why an icon cannot be a tab drawing, or null when it can: one `<svg>...</svg>`, no script. */
function iconProblem(icon: unknown): string | null {
  if (typeof icon !== 'string') return 'icon must be a string of SVG source';
  if (new TextEncoder().encode(icon).length > 8192) return 'icon is longer than 8192 bytes';
  const drawing = icon.trim();
  if (!drawing.startsWith('<svg') || !drawing.endsWith('</svg>')) {
    return 'icon must be one <svg>…</svg> element, and nothing else';
  }
  if (/<script|on\w+\s*=|javascript:/i.test(drawing)) {
    return 'icon carries <script>, an on…= handler or javascript:';
  }
  return null;
}

/** A sub-agent's name: what the page shows, what `run_on_node`'s `node` names and what its history
 *  units are filed under, so it holds the bus-name alphabet and nothing else. */
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function agentNameProblem(name: string, busName: string): string | null {
  if (name === '') return 'a name is required';
  if (!AGENT_NAME.test(name)) {
    return 'a name may hold letters, digits, "-" and "_", at most 64 of them';
  }
  if (name === busName || name === 'agent' || name === 'history') return `"${name}" is reserved`;
  return null;
}

export class AgentFamily {
  readonly scope: BindingScope;
  readonly options: RuntimeOptions;
  /** The one hub every runtime of this identity streams through. */
  readonly hub = new StreamHub();
  readonly main: AgentRuntime;
  readonly #runtimes = new Map<string, AgentRuntime>();
  /** Sub-agents known from the stored list but not started yet. */
  readonly #stored = new Map<string, StoredAgent>();
  #starting: Promise<void> | null = null;
  #restored = false;

  constructor(init: { scope: BindingScope; options?: RuntimeOptions }) {
    this.scope = init.scope;
    this.options = init.options ?? {};
    this.main = new AgentRuntime({ scope: init.scope, options: this.options, group: this });
    this.#runtimes.set(this.main.name, this.main);
  }

  async ready(): Promise<void> {
    if (this.#starting === null) this.#starting = this.#start();
    await this.#starting;
  }

  async close(): Promise<void> {
    for (const runtime of this.#runtimes.values()) await runtime.close();
    this.#runtimes.clear();
    this.#stored.clear();
  }

  async #start(): Promise<void> {
    await this.main.ready();
    await this.#restoreAgents();
  }

  /** The runtime one `agent` argument names, if it is already running. */
  agent(name: unknown): AgentRuntime {
    const wanted = typeof name === 'string' ? agentNameOf(name.trim()) : '';
    if (wanted === '' || wanted === this.main.name) return this.main;
    const runtime = this.#runtimes.get(wanted);
    if (runtime !== undefined) return runtime;
    const known = [this.main.name, ...this.#allNames()].join(', ');
    if (this.#stored.has(wanted)) throw new Error(`agent "${wanted}" is not running yet`);
    throw new Error(`no agent named "${wanted}" here (agents: ${known})`);
  }

  /** The runtime one `agent` argument names, starting a stored sub-agent on first use. */
  async ensureAgent(name: unknown): Promise<AgentRuntime> {
    const wanted = typeof name === 'string' ? agentNameOf(name.trim()) : '';
    if (wanted === '' || wanted === this.main.name) return this.main;
    const running = this.#runtimes.get(wanted);
    if (running !== undefined) return running;
    const saved = this.#stored.get(wanted);
    if (saved !== undefined) return await this.#startStored(saved);
    const known = [this.main.name, ...this.#allNames()].join(', ');
    throw new Error(`no agent named "${wanted}" here (agents: ${known})`);
  }

  /** The main agent first, then the sub-agents it started. */
  rows(): AgentRow[] {
    const own: AgentRow = {
      name: this.main.name,
      topic: this.main.identity.topic,
      parent: null,
      state: this.main.phase(),
      children: this.#runtimes.size - 1,
      ...(this.main.options.icon !== undefined ? { icon: this.main.options.icon } : {}),
    };
    const rows: AgentRow[] = [own];
    const names = new Set([...this.#stored.keys(), ...this.#runtimes.keys()]);
    names.delete(this.main.name);
    for (const name of names) {
      const runtime = this.#runtimes.get(name);
      const saved = this.#stored.get(name);
      rows.push({
        name,
        topic: runtime?.identity.topic ?? `${this.main.identity.topic}.${name}`,
        parent: this.main.name,
        state: runtime?.phase() ?? 'idle',
        children: 0,
        ...(runtime?.options.icon !== undefined
          ? { icon: runtime.options.icon }
          : saved?.icon !== undefined
            ? { icon: saved.icon }
            : {}),
      });
    }
    return rows;
  }

  #allNames(): Set<string> {
    const names = new Set([...this.#stored.keys(), ...this.#runtimes.keys()]);
    names.delete(this.main.name);
    return names;
  }

  #makeRuntime(saved: StoredAgent, selectedProvider: string): AgentRuntime {
    return new AgentRuntime({
      scope: this.scope,
      group: this,
      parent: this.main,
      name: saved.name,
      topic: `${this.main.identity.topic}.${saved.name}`,
      unitPrefix: `sub.${saved.name}.`,
      options: {
        historyRequired: this.options.historyRequired,
        compressionThreshold: this.options.compressionThreshold,
        compressionTokens: this.options.compressionTokens,
        cacheSize: this.main.cache.maxSize,
        allowAskUser: false,
        allowSpawn: false,
        ...(saved.icon !== undefined ? { icon: saved.icon } : {}),
        ...(selectedProvider !== '' ? { providerName: selectedProvider } : {}),
        ...(selectedProvider === '' && this.options.provider !== undefined
          ? { provider: this.options.provider }
          : {}),
      },
    });
  }

  async #startStored(saved: StoredAgent): Promise<AgentRuntime> {
    const selectedProvider = await this.main.providerRowFor(saved.provider);
    const runtime = this.#makeRuntime(saved, selectedProvider);
    await runtime.ready();
    this.#runtimes.set(saved.name, runtime);
    if (selectedProvider !== '') {
      this.#stored.set(saved.name, { ...saved, provider: selectedProvider });
    }
    agentLog('info', 'agent.spawned', { parent: this.main.name, agent: saved.name });
    return runtime;
  }

  async spawnAgent(name: string, icon?: string, provider?: string): Promise<string> {
    return await this.#spawnAgent(name, icon, provider, true);
  }

  async #spawnAgent(
    name: string,
    icon: string | undefined,
    provider: string | undefined,
    persist: boolean,
  ): Promise<string> {
    if (!this.main.allowSpawn()) throw new Error('this agent may not create sub-agents');
    const wanted = name.trim();
    const problem = agentNameProblem(wanted, this.main.identity.busName);
    if (problem !== null) return `cannot create "${wanted}": ${problem}`;
    if (persist && (icon === undefined || icon.trim() === '')) {
      return (
        `cannot create "${wanted}": an icon is required - the tab drawing as one <svg>...</svg> ` +
        'of SVG source'
      );
    }
    if (this.#allNames().has(wanted)) return `an agent named "${wanted}" already runs here`;
    if (this.#allNames().size >= this.main.settings.maxAgents) {
      return `cannot create "${wanted}": too many agents are running`;
    }
    if (icon !== undefined) {
      const bad = iconProblem(icon);
      if (bad !== null) return `cannot create "${wanted}": ${bad}`;
    }
    const selectedProvider = await this.main.providerRowFor(provider);
    const saved: StoredAgent = {
      name: wanted,
      ...(icon !== undefined ? { icon: icon.trim() } : {}),
      ...(selectedProvider !== '' ? { provider: selectedProvider } : {}),
    };
    const runtime = this.#makeRuntime(saved, selectedProvider);
    await runtime.ready();
    this.#stored.set(wanted, saved);
    this.#runtimes.set(wanted, runtime);
    agentLog('info', 'agent.spawned', { parent: this.main.name, agent: wanted });
    if (persist) await this.#saveAgents();
    return (
      `created agent "${wanted}". Hand it a turn with run_on_node ` +
      `{node: "${this.main.identity.busName}", tool_name: "chat", ` +
      `tool_args: {agent: "${wanted}", msg: {role: "user", content: "..."}}}; ` +
      'it shares this bus identity with you and keeps its own transcript, round budget and stop, ' +
      'so ask it for a short report back. It cannot create agents of its own.'
    );
  }

  /** Stop a sub-agent and delete the units it wrote. */
  async destroyAgent(name: string): Promise<string> {
    agentLog('info', 'agent.destroy', { parent: this.main.name, agent: name });
    let runtime = this.#runtimes.get(name);
    const saved = this.#stored.get(name);
    if (runtime === undefined && saved !== undefined) runtime = await this.#startStored(saved);
    if (runtime === undefined || runtime === this.main) {
      return `no agent named "${name}" was created here (running: ${[...this.#allNames()].join(', ') || 'none'})`;
    }
    await runtime.close();
    const left = await runtime.destroySelf();
    this.#runtimes.delete(name);
    this.#stored.delete(name);
    await this.#saveAgents();
    if (left.length > 0) {
      return `destroyed agent "${name}" (${left.length} of its persisted units could not be deleted: ${left.join('; ')})`;
    }
    return `destroyed agent "${name}" (its transcript is deleted)`;
  }

  async agentsChanged(): Promise<void> {
    await this.#saveAgents();
  }

  async settingsChanged(source: AgentRuntime): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      if (runtime !== source) await runtime.applyRuntimeSettings(false);
    }
  }

  async #saveAgents(): Promise<void> {
    try {
      const agents: StoredAgent[] = [...this.#allNames()].map((name) => {
        const runtime = this.#runtimes.get(name);
        const saved = this.#stored.get(name);
        const provider = runtime?.providerName ?? runtime?.options.providerName ?? saved?.provider;
        const icon = runtime?.options.icon ?? saved?.icon;
        return {
          name,
          ...(icon !== undefined ? { icon } : {}),
          ...(provider !== undefined ? { provider } : {}),
        };
      });
      for (const agent of agents) this.#stored.set(agent.name, agent);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const unit = subagentsStorage(this.scope, this.main.unitPrefix);
        await unit.load();
        unit.meta = { names: agents.map((agent) => agent.name), agents };
        try {
          await unit.save();
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    } catch {
      // A note about children may not fail the turn.
    }
  }

  async #restoreAgents(): Promise<void> {
    if (this.#restored || !this.main.allowSpawn()) return;
    this.#restored = true;
    try {
      const unit = subagentsStorage(this.scope, this.main.unitPrefix);
      await unit.load();
      if (unit.revision === 0) return;
      const meta = unit.meta as { names?: unknown; agents?: unknown };
      const listed = Array.isArray(meta.agents)
        ? meta.agents
        : Array.isArray(meta.names)
          ? meta.names
          : [];
      for (const row of listed) {
        const saved = storedAgentOf(row);
        if (saved !== null) this.#stored.set(saved.name, saved);
      }
    } catch {
      // Names that cannot be read are names that are not there.
    }
  }
}

function storedAgentOf(value: unknown): StoredAgent | null {
  if (typeof value === 'string') return { name: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const saved = value as { name?: unknown; icon?: unknown; provider?: unknown };
  if (typeof saved.name !== 'string' || saved.name === '') return null;
  return {
    name: saved.name,
    ...(typeof saved.icon === 'string' ? { icon: saved.icon } : {}),
    ...(typeof saved.provider === 'string' ? { provider: saved.provider } : {}),
  };
}
