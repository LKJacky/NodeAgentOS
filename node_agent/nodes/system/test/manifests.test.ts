// Repository manifests spell out their callers, so the runtime's `['*']` default for an absent
// list cannot silently open a capability. Tests also pin the few deliberate per-package policies.
//
// Two shapes are allowed, and both are explicit:
//   - the cap names its `callers` (the narrow default), or
//   - the cap is open to every node by design: no `callers` at all (the bus's allow-all default).
//     Whether that open cap is editable is a separate per-cap decision.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../..', import.meta.url));

/** The capabilities that are open to every node on purpose: no callers, and not editable. */
const OPEN: Record<string, readonly string[]> = {
  agent: ['chat', 'chat_no_wait', 'status', 'agents'],
  system: ['language', 'timezone', 'add_timer', 'cancel_timer', 'timers'],
  timer: ['wake'],
};

/** Packages whose manifests still ride the bus default without declaring it. They were imported as
 *  they were written elsewhere; this list is the debt, not a policy. */
const UNDECLARED = new Set(['notes', 'todo', 'search']);

interface CapSchema {
  callers?: unknown;
  expose?: unknown;
  allow_edit_permission?: unknown;
}

interface Manifest {
  node?: { id?: string; i18n?: string; caps?: Record<string, CapSchema> };
}

/** A resource file's shape, as far as labels are concerned: `label.*` keys, flattened by a dot. */
interface ResourceFile {
  label?: {
    node?: unknown;
    caps?: Record<string, unknown>;
    args?: Record<string, Record<string, unknown>>;
  };
}

test('every capability is explicit: callers, or open by design', () => {
  const gaps: string[] = [];

  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packages, entry.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const inside = OPEN[entry.name] ?? [];
    for (const cap of inside)
      assert.ok(
        manifest.node?.caps?.[cap] !== undefined,
        `${entry.name}.${cap} is listed as open but missing from package.json`,
      );

    for (const [cap, schema] of Object.entries(manifest.node?.caps ?? {})) {
      if (cap === 'ui') {
        // The bus normalises `ui` on its own: a page is served by webui and is never a permission
        // table entry. Manifests may say so too, but they do not have to.
        assert.notEqual(schema.expose, true, `${entry.name}.ui must not be exposed to other nodes`);
        if (schema.allow_edit_permission !== undefined)
          assert.equal(
            schema.allow_edit_permission,
            false,
            `${entry.name}.ui must not be editable`,
          );
        continue;
      }

      const open = inside.includes(cap);
      if (open) {
        assert.ok(
          !('callers' in schema),
          `${entry.name}.${cap} is open to every node: it must not declare callers`,
        );
      } else if (schema.callers === undefined) {
        // No callers and no opt-out: this rides the allow-all default while still looking like a
        // permission someone could edit. Counted, not asserted here (see UNDECLARED).
        gaps.push(`${entry.name}.${cap}`);
        continue;
      } else {
        assert.ok(
          Array.isArray(schema.callers),
          `${entry.name}.${cap} must declare a callers array in package.json`,
        );
      }

      assert.ok(
        !(schema.callers as unknown[] | undefined)?.includes(manifest.node?.id),
        `${entry.name}.${cap} must not list its own node; self-calls are always allowed`,
      );
      assert.ok(
        !(schema.callers as unknown[] | undefined)?.includes('webui'),
        `${entry.name}.${cap} must not list webui; webui is always allowed`,
      );
      if (entry.name === 'agent') {
        // The caps open to every node are exactly the ones the agent exposes to its siblings.
        const exposed = inside.includes(cap);
        assert.equal(schema.expose, exposed, `agent.${cap} must have expose: ${exposed}`);
      }
      if (entry.name === 'history')
        assert.equal(schema.allow_edit_permission, false, `history.${cap} must not be editable`);
      if (entry.name === 'userpage')
        assert.equal(schema.expose, false, `userpage.${cap} must not be exposed to other nodes`);
      // The caps that read and decide the user's language belong to the shell and to the runtime:
      // `ensure_language` is the browser's own read (no sibling caller), and `locale` is one the
      // runtime asks once, at startup, to settle the language before the setup runs. Neither is
      // editable: the policy is not the user's to hand out.
      if (entry.name === 'system' && ['locale', 'ensure_language'].includes(cap)) {
        const callers = cap === 'locale' ? ['runtime-control'] : [];
        assert.deepEqual(schema.callers, callers, `system.${cap} callers`);
        assert.equal(
          schema.allow_edit_permission,
          false,
          `system.${cap} must stay out of the permission editor`,
        );
      }
      if (entry.name === 'provider' && schema.expose !== false) {
        assert.deepEqual(schema.callers, ['agent'], `provider.${cap} must only allow agent`);
        assert.equal(schema.allow_edit_permission, false, `provider.${cap} must not be editable`);
      }
      // history is infrastructure, and the two self-service permission APIs must be callable by
      // every node. Those wildcards are deliberate; elsewhere `*` would silently allow everyone.
      // `timer`'s three are deliberate in the same way and were reviewed as such: the timer is the
      // user's clock, any node may ask it for a wake (that is what `wake` already is), and `set`
      // wakes the caller when it names no other node. They name `*` in the manifest rather than
      // riding the bus's default, so the decision is written where a reader of the manifest sees it.
      const wildcard =
        entry.name === 'history' ||
        (entry.name === 'timer' && ['set', 'cancel', 'list'].includes(cap)) ||
        (entry.name === 'system' && ['set_own_permission', 'clear_own_permission'].includes(cap));
      if (!wildcard)
        assert.ok(
          !(schema.callers as unknown[] | undefined)?.includes('*'),
          `${entry.name}.${cap} must not use the wildcard caller`,
        );
    }
  }

  // Only the packages named here may still ride the default without saying so.
  for (const gap of gaps)
    assert.ok(
      UNDECLARED.has(gap.split('.')[0] ?? ''),
      `${gap} has neither callers nor allow_edit_permission: false`,
    );
});

// A package that publishes display names has to publish all of them. A label that is missing does not
// fail loudly — the page simply falls back to the canonical name — so a gap would be found by a reader
// of that language and never by a test. This is that test: every capability and every argument it
// declares, in every language file, and no label for something the manifest does not have.
test('a package that publishes labels labels every capability and argument', () => {
  const gaps: string[] = [];
  let labelled = 0;

  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    const directory = join(packages, entry.name);
    // A directory without a package.json is not a node (memory/ is a library the nodes import).
    if (!existsSync(join(directory, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
    const i18n = manifest.node?.i18n;
    if (i18n === undefined) continue;
    labelled += 1;

    // The words are authored under src/ and copied into the build output the manifest names; the
    // test reads what a translator edits when it is there.
    const folder = join(
      directory,
      i18n.startsWith('dist/') ? 'src/' + i18n.slice('dist/'.length) : i18n,
    );
    const caps = manifest.node?.caps ?? {};

    for (const file of readdirSync(folder).filter((name) => name.endsWith('.json'))) {
      const locale = file.slice(0, -'.json'.length);
      const resource = JSON.parse(readFileSync(join(folder, file), 'utf8')) as ResourceFile;
      const labels = resource.label ?? {};
      if (typeof labels.node !== 'string' || labels.node === '')
        gaps.push(`${entry.name}/${locale}: label.node is missing`);

      for (const [cap, schema] of Object.entries(caps)) {
        if (typeof labels.caps?.[cap] !== 'string')
          gaps.push(`${entry.name}/${locale}: label.caps.${cap}`);
        for (const argument of Object.keys(schema.properties ?? {}))
          if (typeof labels.args?.[cap]?.[argument] !== 'string')
            gaps.push(`${entry.name}/${locale}: label.args.${cap}.${argument}`);
      }

      // And nothing extra: a label for a cap or an argument that no longer exists is a page telling
      // a reader about something the bus would refuse.
      for (const cap of Object.keys(labels.caps ?? {}))
        if (caps[cap] === undefined)
          gaps.push(`${entry.name}/${locale}: label.caps.${cap} has no cap`);
      for (const [cap, args] of Object.entries(labels.args ?? {}))
        for (const argument of Object.keys(args ?? {}))
          if (caps[cap]?.properties?.[argument] === undefined)
            gaps.push(`${entry.name}/${locale}: label.args.${cap}.${argument} has no argument`);
    }
  }

  assert.ok(labelled > 0, 'no package publishes labels, so this test is not checking anything');
  assert.deepEqual(gaps, [], `label gaps: ${gaps.join(' | ')}`);
});
