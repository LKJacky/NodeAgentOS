// system: the privileged, long-lived node. Its capabilities are intentionally small; the
// scheduler behind add_timer is the only part that outlives a call.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Node,
  paintPage,
  labelText,
  loadResource,
  requireBindings,
  type BindingScope,
  type NodeContext,
  type NodeHandlers,
  type OutboundCallEnvelope,
  type ResultEnvelope,
  type ToolArgs,
} from '@node-agent/sdk';
import { SystemScheduler, type LocaleView, type PermissionView } from './scheduler.ts';

const NODE_ID = 'system';
const PAGE = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
/** This node's own sentences, from the files beside the code: no words of the SDK involved. */
const RESOURCE = loadResource(new URL('./i18n/', import.meta.url));
/** The topic a language change is announced on. A page subscribes to it through the webui's /events. */
const LANGUAGE_TOPIC = 'language';

/** Tests and the standalone `serve.ts` entry can install one scheduler directly. */
let active: SystemScheduler | null = null;

export function setSystemScheduler(scheduler: SystemScheduler | null): void {
  active = scheduler;
}

const SCHEDULER_BINDING = 'system-scheduler';

/** A bound object has the host's lifetime, not a call's: exactly what a timer queue needs. */
function bound(scope: BindingScope): SystemScheduler {
  return new SystemScheduler(
    {
      call: async (call: OutboundCallEnvelope): Promise<ResultEnvelope> => {
        try {
          const value = await scope.call(call.to, call.payload.cap, call.payload.args ?? {});
          return {
            id: randomUUID(),
            type: 'result',
            from: 'system',
            to: 'system',
            replyTo: call.id,
            tenantId: scope.tenantId,
            payload: { ok: true, value },
          };
        } catch (error) {
          return {
            id: randomUUID(),
            type: 'result',
            from: 'system',
            to: 'system',
            replyTo: call.id,
            tenantId: scope.tenantId,
            payload: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    },
    scope.tenantId,
  );
}

export class SystemNode extends Node {
  readonly handlers: NodeHandlers;

  private readonly scheduler: SystemScheduler;

  /** A private node is identified by its registration source, never by its manifest. */
  private async isPrivate(target: unknown): Promise<boolean> {
    if (typeof target !== 'string' || target === '') return false;
    const nodes = (await this.ctx.listNodes?.()) ?? [];
    return nodes.some((node) => node.name === target && node.scope === 'private');
  }

  /** A cap whose manifest says `allow_edit_permission: false` is not a table entry. */
  private async assertEditable(target: unknown, cap: unknown): Promise<void> {
    const name = typeof target === 'string' ? target : '';
    const key = typeof cap === 'string' ? cap : '';
    const caps = (await this.ctx.listCapabilities?.(name)) ?? [];
    const found = caps.find((one) => one.cap === key);
    const parameters = found?.parameters as { allow_edit_permission?: unknown } | undefined;
    if (parameters?.allow_edit_permission === false)
      throw new Error(`${name}.${key} does not allow permission edits`);
  }

  /**
   * A changed language is a fact about the user, not about one call: it goes on the bus so every open
   * page can redraw (the SDK's browser half listens on this topic, through the webui's /events).
   */
  private publishLanguage(view: LocaleView): void {
    this.ctx.publish(LANGUAGE_TOPIC, { language: view.language, resolved: view.resolved });
  }

  constructor(ctx: NodeContext) {
    super(ctx);
    this.scheduler =
      active ?? requireBindings(ctx).bind(SCHEDULER_BINDING, (scope) => bound(scope));
    this.handlers = {
      language: async () => await this.scheduler.language(),
      locale: async () => await this.scheduler.locale(),
      // The one write a first visit makes. The browser says what its user reads; only a profile that
      // has never been chosen takes the answer, and the change is announced exactly once.
      ensure_language: async (args: ToolArgs) => {
        const ensured = await this.scheduler.ensureLanguage(args.browser);
        if (ensured.changed) this.publishLanguage(ensured);
        return ensured;
      },
      timezone: async () => await this.scheduler.timezone(),
      add_timer: async (args: ToolArgs) =>
        await this.scheduler.add(this.ctx.tenantId, this.ctx.from, args),
      settings: async (args: ToolArgs) => {
        if (args.language === undefined && args.timezone === undefined)
          return await this.scheduler.profile();
        const before = await this.scheduler.locale();
        const profile = await this.scheduler.updateProfile(args);
        const after = await this.scheduler.locale();
        // Only a language change is news: a timezone is read when it is needed, by whoever needs it.
        if (after.language !== before.language) this.publishLanguage(after);
        return profile;
      },
      timers: async () => await this.scheduler.timers(),
      cancel_timer: async (args: ToolArgs) => await this.scheduler.cancel(args.id),
      authorize: async (args: ToolArgs) => {
        if (this.ctx.from !== 'bus')
          throw new Error('authorize is reserved for the bus permission check');
        return await this.scheduler.authorize(args);
      },
      permissions: async () => {
        const rows: PermissionView[] = [];
        // One language for the whole table: the one the page is drawn in. Labels are display names
        // only — the `target`/`cap`/argument names in the same rows stay what a caller would send.
        const { resolved } = await this.scheduler.locale();
        const seen = new Set<string>();
        const privateNames = new Set<string>();
        const nodes = (await this.ctx.listNodes?.()) ?? [];
        for (const node of nodes) {
          const privateNode = node.scope === 'private';
          if (privateNode) privateNames.add(node.name);
          const caps = (await this.ctx.listCapabilities?.(node.name)) ?? [];
          for (const cap of caps) {
            const rowKey = `${node.name}\u0000${cap.cap}`;
            // authorize is the bus's internal check, never an editable user-facing policy.
            if (node.name === NODE_ID && cap.cap === 'authorize') {
              seen.add(rowKey);
              continue;
            }
            const parameters = cap.parameters as {
              callers?: readonly string[];
              allow_edit_permission?: unknown;
              expose?: unknown;
            };
            // Hidden caps are not table entries, even when their manifest allows edits.
            if (parameters.expose === false) {
              seen.add(rowKey);
              continue;
            }
            // Private node permissions are visible but not editable and never come from an
            // override: they always read as the default allow-all row.
            const callers = privateNode
              ? ['*']
              : Array.isArray(parameters.callers)
                ? parameters.callers
                : ['*'];
            const editable = !privateNode && parameters.allow_edit_permission !== false;
            const row = await this.scheduler.permission(
              node.name,
              cap.cap,
              callers,
              editable,
              true,
              privateNode,
            );
            const nodeLabel = labelText(node.labels?.node, resolved);
            const capLabel = labelText(cap.labels, resolved);
            const argLabels: Record<string, string> = {};
            for (const [arg, labels] of Object.entries(cap.argLabels ?? {})) {
              const text = labelText(labels, resolved);
              if (text !== undefined) argLabels[arg] = text;
            }
            rows.push({
              ...row,
              ...(nodeLabel === undefined ? {} : { nodeLabel }),
              ...(capLabel === undefined ? {} : { capLabel }),
              ...(Object.keys(argLabels).length === 0 ? {} : { argLabels }),
            });
            seen.add(rowKey);
          }
        }
        // Keep saved overrides visible even while their node is offline.
        for (const rule of await this.scheduler.overrides()) {
          if (privateNames.has(rule.target) || seen.has(`${rule.target}\u0000${rule.cap}`))
            continue;
          rows.push(await this.scheduler.permission(rule.target, rule.cap, ['*']));
        }
        return rows.sort((a, b) => a.target.localeCompare(b.target) || a.cap.localeCompare(b.cap));
      },
      set_own_permission: async (args: ToolArgs) => {
        if (await this.isPrivate(this.ctx.from))
          throw new Error('private nodes are not editable through system');
        return await this.scheduler.setPermission(this.ctx.from, args.cap, args.callers);
      },
      clear_own_permission: async (args: ToolArgs) => {
        if (await this.isPrivate(this.ctx.from))
          throw new Error('private nodes are not editable through system');
        return await this.scheduler.clearPermission(this.ctx.from, args.cap);
      },
      set_permission: async (args: ToolArgs) => {
        if (await this.isPrivate(args.target))
          throw new Error('private nodes are not editable through system');
        await this.assertEditable(args.target, args.cap);
        return await this.scheduler.setPermission(args.target, args.cap, args.callers);
      },
      clear_permission: async (args: ToolArgs) => {
        if (await this.isPrivate(args.target))
          throw new Error('private nodes are not editable through system');
        await this.assertEditable(args.target, args.cap);
        return await this.scheduler.clearPermission(args.target, args.cap);
      },
      ui: async () => await this.page(),
    };
  }

  /**
   * The settings page, in the language the user reads.
   *
   * One file, three things per request: `paintPage` writes the words of the language in force into the
   * `data-text-key` markers (so the first paint is already right), embeds the resource as one JSON
   * script tag, and sets `<html lang>` — a panel opens in a frame, so the browser half is not handed
   * the shell's own language and reads it from that tag. The markers stay, so a later change on the
   * `language` event is redrawn without a reload. The sentences the page builds at run time are the
   * same keys, looked up through the SDK's `t` in the script at the bottom of `src/ui.html`.
   */
  private async page(): Promise<string> {
    // This node keeps the language itself, so it does not wait to be told one; `paintPage` writes the
    // words in before the page leaves, so the first paint is already right (see `src/ui.html`).
    const { resolved } = await this.scheduler.locale();
    const { timezone } = await this.scheduler.profile();
    const painted = paintPage(PAGE, RESOURCE, { language: resolved }).replace(
      '__SYSTEM_NODE__',
      () => JSON.stringify(NODE_ID).slice(1, -1),
    );
    return paintSettings(painted, resolved, timezone);
  }
}

/** Put a value into HTML text or an attribute without letting it close either. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The settings form as it stands, written into the page before it leaves.
 *
 * Without this the language `<select>` showed its first option — "中文" — and the timezone box was
 * empty until the page's own `system.settings` call came back, so an English reader saw Chinese for a
 * round trip (and a Save pressed in that window would have stored zh-CN). The page still asks for the
 * settings afterwards; it now confirms what is shown instead of correcting it.
 */
export function paintSettings(html: string, language: string, timezone: string): string {
  const select = /(<select id="language"[^>]*>)([\s\S]*?)(<\/select>)/;
  const painted = html.replace(select, (_whole, open: string, options: string, close: string) => {
    const marked = options
      .replace(/\sselected(?=[\s>])/g, '')
      .replace(/<option value="([^"]*)"/g, (option, value: string) =>
        value === language ? `${option} selected` : option,
      );
    return `${open}${marked}${close}`;
  });
  const zone = escapeHtml(timezone);
  return painted.replace(
    '<select id="timezone"></select>',
    () =>
      `<select id="timezone"><option value="${zone}" selected>${zone.replaceAll('_', ' ')}</option></select>`,
  );
}

export default SystemNode;
