// Every agent this node hosts: one runtime each, one shared bus identity, and one hub they all
// stream through. The agents are held the same way; only the default name is privileged, because it
// is the one agent that cannot be destroyed.
import type { BindingScope } from '@node-agent/sdk';
import { agentLog } from './log.js';
import { agentNameOf } from './names.js';
import { AgentRuntime, type AgentRow, type RuntimeOptions } from './runtime.js';
import { StreamHub } from './model.js';
import { listUnits, storedUnit, subagentsStorage, type StoredAgent } from './storage.js';

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
  /** The name every agent defaults to; only this one cannot be destroyed. */
  readonly #mainName: string;
  /** Every agent this family holds, running or waiting to be started. */
  readonly #agents = new Map<string, AgentRuntime>();
  /** Sub-agents known from the stored list but not started yet. */
  readonly #stored = new Map<string, StoredAgent>();
  #starting: Promise<void> | null = null;
  #ready = false;
  #restored = false;

  constructor(init: { scope: BindingScope; options?: RuntimeOptions }) {
    this.scope = init.scope;
    this.options = init.options ?? {};
    this.#mainName = this.scope.nodeId;
    this.#agents.set(this.#mainName, this.#makeRuntime({ name: this.#mainName }, ''));
  }

  get main(): AgentRuntime {
    return this.#agents.get(this.#mainName) as AgentRuntime;
  }

  async ready(): Promise<void> {
    if (this.#starting === null) this.#starting = this.#start();
    await this.#starting;
  }

  async close(): Promise<void> {
    for (const runtime of this.#agents.values()) await runtime.close();
    this.#agents.clear();
    this.#stored.clear();
  }

  async #start(): Promise<void> {
    await this.main.ready();
    await this.#restoreAgents();
    this.#ready = true;
  }

  #nameOf(name: unknown): string {
    const wanted = typeof name === 'string' ? agentNameOf(name.trim()) : '';
    return wanted === '' ? this.#mainName : wanted;
  }

  /** The runtime one `agent` argument names, only once it is running. */
  started(name: unknown): AgentRuntime | undefined {
    if (!this.#ready) return undefined;
    const runtime = this.#agents.get(this.#nameOf(name));
    return runtime === undefined || runtime.closed || runtime.env === null ? undefined : runtime;
  }

  /** The runtime one `agent` argument names, if it is already running. */
  agent(name: unknown): AgentRuntime {
    const wanted = this.#nameOf(name);
    const runtime = this.#agents.get(wanted);
    if (runtime !== undefined) return runtime;
    const known = [...this.#allNames()].join(', ');
    if (this.#stored.has(wanted)) throw new Error(`agent "${wanted}" is not running yet`);
    throw new Error(`no agent named "${wanted}" here (agents: ${known})`);
  }

  /** The runtime one `agent` argument names, starting it on first use. */
  async ensureAgent(name: unknown): Promise<AgentRuntime> {
    const wanted = this.#nameOf(name);
    const running = this.#agents.get(wanted);
    if (running !== undefined && !running.closed && running.env !== null) return running;
    this.#agents.delete(wanted);
    const saved = this.#stored.get(wanted);
    if (saved !== undefined) return await this.#startStored(saved);
    if (wanted === this.#mainName) {
      const runtime = this.#makeRuntime({ name: wanted }, '');
      await runtime.ready();
      this.#agents.set(wanted, runtime);
      return runtime;
    }
    throw new Error(
      `no agent named "${wanted}" here (agents: ${[...this.#allNames()].join(', ')})`,
    );
  }

  /** Every agent, the main one first. */
  rows(): AgentRow[] {
    const names = [...this.#allNames()];
    names.sort((a, b) => (a === this.#mainName ? -1 : b === this.#mainName ? 1 : 0));
    return names.map((name) => {
      const runtime = this.#agents.get(name);
      const saved = this.#stored.get(name);
      const main = name === this.#mainName;
      return {
        name,
        topic: runtime?.identity.topic ?? (main ? this.#mainName : `${this.#mainName}.${name}`),
        parent: main ? null : this.#mainName,
        state: runtime?.phase() ?? 'idle',
        children: main ? names.length - 1 : 0,
        ...(runtime?.options.icon !== undefined
          ? { icon: runtime.options.icon }
          : saved?.icon !== undefined
            ? { icon: saved.icon }
            : {}),
      };
    });
  }

  #allNames(): Set<string> {
    return new Set([...this.#stored.keys(), ...this.#agents.keys()]);
  }

  #subagentNames(): Set<string> {
    const names = this.#allNames();
    names.delete(this.#mainName);
    return names;
  }

  #makeRuntime(saved: StoredAgent, selectedProvider: string): AgentRuntime {
    const main = saved.name === this.#mainName;
    return new AgentRuntime({
      scope: this.scope,
      group: this,
      name: saved.name,
      topic: main ? this.#mainName : `${this.#mainName}.${saved.name}`,
      unitPrefix: main ? '' : `sub.${saved.name}.`,
      ...(main ? {} : { parent: this.main }),
      options: main
        ? this.options
        : {
            historyRequired: this.options.historyRequired,
            compressionThreshold: this.options.compressionThreshold,
            compressionTokens: this.options.compressionTokens,
            cacheSize: this.main.cache.maxSize,
            idleDestroyMs: this.options.idleDestroyMs,
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
    this.#agents.set(saved.name, runtime);
    if (selectedProvider !== '') {
      this.#stored.set(saved.name, { ...saved, provider: selectedProvider });
    }
    agentLog('info', 'agent.spawned', { parent: this.#mainName, agent: saved.name });
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
    if (this.#subagentNames().size >= this.main.settings.maxAgents) {
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
    this.#agents.set(wanted, runtime);
    agentLog('info', 'agent.spawned', { parent: this.#mainName, agent: wanted });
    if (persist) await this.#saveAgents();
    return (
      `created agent "${wanted}". Hand it a turn with run_on_node ` +
      `{node: "${this.main.identity.busName}", tool_name: "chat", ` +
      `tool_args: {agent: "${wanted}", msg: {role: "user", content: "..."}}}; ` +
      'it shares this bus identity with you and keeps its own transcript, round budget and stop, ' +
      'so ask it for a short report back. It cannot create agents of its own.'
    );
  }

  /** Stop an agent and delete the units it wrote, without starting a runtime just to delete it. */
  async destroyAgent(name: string): Promise<string> {
    agentLog('info', 'agent.destroy', { parent: this.#mainName, agent: name });
    if (name === this.#mainName)
      return `no agent named "${name}" was created here (running: ${[...this.#subagentNames()].join(', ') || 'none'})`;
    await this.#restoreAgents();
    const runtime = this.#agents.get(name);
    const saved = this.#stored.get(name);
    if (runtime === undefined && saved === undefined) {
      return `no agent named "${name}" was created here (running: ${[...this.#subagentNames()].join(', ') || 'none'})`;
    }
    let left: string[];
    if (runtime !== undefined) {
      await runtime.close();
      left = await runtime.destroySelf();
    } else {
      left = await this.#deleteUnits(`sub.${name}.`);
    }
    this.#agents.delete(name);
    this.#stored.delete(name);
    await this.#saveAgents();
    if (left.length > 0) {
      return `destroyed agent "${name}" (${left.length} of its persisted units could not be deleted: ${left.join('; ')})`;
    }
    return `destroyed agent "${name}" (its transcript is deleted)`;
  }

  /** Delete every unit under one prefix, for an agent that has no runtime to ask. */
  async #deleteUnits(prefix: string): Promise<string[]> {
    const left: string[] = [];
    const listed = async (): Promise<{ unitId: string }[]> => {
      try {
        return await listUnits(this.scope, prefix);
      } catch (error) {
        left.push(`*: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    };
    for (const unit of await listed()) {
      try {
        const localId = unit.unitId.slice(prefix.length);
        const stored = storedUnit(this.scope, prefix, localId);
        await stored.load();
        if (stored.revision > 0) await stored.delete();
      } catch (error) {
        left.push(`${unit.unitId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const unit of await listed()) left.push(`${unit.unitId}: still there after delete`);
    return left;
  }

  /** Close an idle agent; its transcript and its name stay in history. */
  async retireAgent(name: string): Promise<void> {
    const runtime = this.#agents.get(name);
    if (runtime === undefined) return;
    await runtime.close();
    this.#agents.delete(name);
    if (name === this.#mainName) this.#agents.set(name, this.#makeRuntime({ name }, ''));
    await this.#saveAgents();
    agentLog('info', 'agent.retired', {
      parent: runtime.parent?.name,
      agent: name,
      main: name === this.#mainName,
    });
  }

  async agentsChanged(): Promise<void> {
    await this.#saveAgents();
  }

  async settingsChanged(source: AgentRuntime): Promise<void> {
    for (const runtime of this.#agents.values()) {
      if (runtime !== source) await runtime.applyRuntimeSettings(false);
    }
  }

  async #saveAgents(): Promise<void> {
    try {
      const agents: StoredAgent[] = [...this.#subagentNames()].map((name) => {
        const runtime = this.#agents.get(name);
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
