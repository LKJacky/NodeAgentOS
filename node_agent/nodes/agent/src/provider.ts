// The provider rows one agent may use, and the row it chose, read and written as units: a page can
// ask about a stored sub-agent without starting it, just as it reads its history.
import type { UnitContext } from '@node-agent/sdk';
import { ProviderNodes } from './model.js';
import { ActiveProviderUnit, SubagentsUnit } from './storage.js';

export type ProviderRow = { name: string; active: boolean };
export type ProviderState = {
  providers: ProviderRow[];
  active: string;
  persistent: boolean;
};

function activeUnit(ctx: UnitContext, prefix: string): ActiveProviderUnit {
  return new ActiveProviderUnit(ctx, `${prefix}active_provider`);
}

async function readActive(ctx: UnitContext, prefix: string): Promise<string> {
  const unit = activeUnit(ctx, prefix);
  await unit.load();
  return typeof unit.meta.name === 'string' ? unit.meta.name : '';
}

/** Record a sub-agent's own choice beside its name in the parent's list. */
async function noteSubagent(ctx: UnitContext, prefix: string, row: string): Promise<void> {
  if (!prefix.startsWith('sub.') || !prefix.endsWith('.')) return;
  const name = prefix.slice(4, -1);
  const unit = new SubagentsUnit(ctx, 'subagents');
  await unit.load();
  const agents = Array.isArray(unit.meta.agents) ? unit.meta.agents : [];
  const found = agents.find((each) => each.name === name);
  if (found === undefined) return;
  found.provider = row;
  await unit.save();
}

/** Read or change one agent's provider selection. No runtime is built to answer it. */
export async function providerState(
  ctx: UnitContext,
  prefix: string,
  action: unknown,
  name: unknown,
): Promise<ProviderState> {
  const rows = await new ProviderNodes(() => ctx).names();
  const read = String(action ?? 'list');
  if (read !== 'list' && read !== 'select') throw new Error(`unknown provider action "${read}"`);

  let active = '';
  if (rows.length > 0) {
    const stored = await readActive(ctx, prefix);
    active = ProviderNodes.rowOf(stored, rows) ?? (stored !== '' ? stored : (rows[0] as string));
  }
  if (read === 'list') {
    return {
      providers: rows.map((row) => ({ name: row, active: row === active })),
      active,
      persistent: true,
    };
  }

  if (rows.length === 0)
    throw new Error('no provider node is on the bus — connect @node-agent/provider first');
  const wanted = String(name ?? '');
  const row = ProviderNodes.rowOf(wanted, rows);
  if (row === null) {
    throw new Error(`no provider "${wanted}" (available: ${rows.join(', ')})`);
  }
  const unit = activeUnit(ctx, prefix);
  await unit.load();
  unit.meta = { name: row };
  await unit.save();
  await noteSubagent(ctx, prefix, row);
  return {
    providers: rows.map((entry) => ({ name: entry, active: entry === row })),
    active: row,
    persistent: true,
  };
}
