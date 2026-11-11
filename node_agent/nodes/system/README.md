# node-agent-system

Privileged system node. It is not a store package: `dist/serve.js` owns one long-lived bus
connection and a scheduler, then registers the `system` node for calls.

Capabilities:

- `language` - the user's language as a tag to draw with (`zh-CN` or `en`). Never empty: a profile nobody has chosen yet answers with `en`, so the agent prompt and every other reader keep getting a string.
- `locale` - `{ language, resolved }`: what the profile holds (`null` until someone chooses) and what to draw with. This is what a page reads. `expose: false`: webui and the node itself may call it, no other node sees it.
- `ensure_language({ browser })` - the one write a first visit may make. When the stored language is `null`, it resolves the browser's `Accept-Language` to `zh-CN` or `en`, persists it and announces it; every later call answers `changed: false` and writes nothing. webui calls it on the first request, so the user's own browser decides the language exactly once. `expose: false`: a sibling node cannot set the user's language.
- `timezone` - the persisted IANA timezone (defaults from `NODE_AGENT_TIMEZONE`, `TZ`, or the runtime zone).
- `add_timer({ id, at, callpayload })` - persist a timer, then call the caller's node at `at` with `callpayload` (`{ cap, args }`).
- `settings({ language?, timezone? })` - read settings with no arguments, or persist both values. A language change is announced; re-sending the same language is not.
- `timers` - list currently pending timers.
- `ui` - the settings form, pending-timer list and permission editor, drawn in the user's language. The page keeps its words in its own files (`src/i18n/en.json`, `src/i18n/zh-CN.json`); the `ui` answer embeds them as one JSON script tag and carries the stored tag as `<html lang="…">`, so the SDK's browser half draws every `data-text-key` element and redraws it when the language changes. The SDK holds none of these words.

Display names: the manifest carries `labels` (this node's name, its capabilities' names and their
arguments' names, per language), projected at load from `src/i18n/*.json` by `node.i18n: "dist/i18n"`.
The identifiers never change — `system`, `add_timer`, `browser` are still what a call sends and what
the agent's tools are called — a label is only what a page writes. The page shows them in the
permission table, with the canonical name in the tooltip.

The `language` topic:

A language change is published as an event on the `language` topic with `{ language, resolved }` (the
stored tag and the one in force). Nothing has to be told in advance: a page subscribes through the
webui's `/events?node=system&topic=language`, and the SDK's browser half (`/sdk/i18n-client.js`)
does that on its own, redrawing its `data-text-en` / `data-text-cn` markers when the answer arrives.
The SDK carries no sentences: a page writes its own, or wraps them in a `Text` from `@node-agent/sdk`.

Permission capabilities:

- `authorize({ caller, target, cap, tenant, defaultCallers? })` - the bus's internal check before it
  forwards a call. It answers `{ allow, reason? }`. Only a call whose `from` is `bus` is accepted;
  every other caller is refused. A node may always call itself, regardless of the table.
  A saved override for `target.cap` wins, otherwise
  `defaultCallers` applies. An absent `callers` field defaults to `['*']` (everyone); an
  explicitly empty list allows nobody. A list with `*`, the exact caller
  name, or the caller `*` itself is allowed.
- `permissions` - every node/cap pair the bus advertises, plus saved overrides whose node is
  offline, with the callers in force and `source: 'default' | 'override'`, the declared default
  callers, and the override callers when there is one. A capability without a `callers` field
  defaults to `['*']`; an explicitly empty list allows nobody.
- `set_permission({ target, cap, callers })` - save an override (an empty list denies everyone).
- `clear_permission({ target, cap })` - delete the override and fall back to the default.

State lives in history units `system.profile`, `system.timers` and `system.permissions`. The
scheduler reloads them on startup, so a restart keeps pending timers and permission overrides.

```bash
npm install
npm run build
NODE_AGENT_BUS_URL='<BUS_URL>' NODE_AGENT_TOKEN='<TOKEN>' node dist/serve.js
```

Capability schema controls:

- `expose: false` — only the capability's own node, its `webui` page, and the trusted
  `runtime-control` service tenant may call it. The permission table cannot widen it to
  ordinary nodes.
- `allow_edit_permission: false` — the cap is hidden from the permission UI and
  `set_permission` / `clear_permission` refuse to change it.
- Absent flags default to `true`, preserving the normal editable, exposed behaviour.

Permission edits have two scopes:

- `set_own_permission({ cap, callers })` / `clear_own_permission({ cap })` — any node edits
  only its own capability. These APIs are callable by every node and are fixed in the manifest.
- `set_permission({ target, cap, callers })` / `clear_permission({ target, cap })` — the global
  table. It is an ordinary capability: `webui` is implicitly allowed, its default caller list is
  empty, and webui may grant it to other nodes like any other cap.
