# Changelog

## v0.0.1 (2026-10-26) — first public release

Public-release baseline of the standalone DeepSeek Harness plugin
`dsh-subagent-plus`. Version line restarts at v0.0.1; the internal
development numbers 0.1.0–0.2.5 (21 commits) are archived history and remain
below for reference — the v0.0.1 tree is content-identical to the internal
0.2.5 final plus the release-readiness pass:

- release readiness: dead code/keys removed (iconButtonStyle, badge.title,
  usableFallback deduplicated into the host hook), the registration cache now
  invalidates on `llm/adapters-updated` (a removed adapter no longer pins
  children onto a gone route), the unregistered-pin warning is prefixed and
  latched to one line per lifetime, the settings page explains an unreadable
  stored value instead of a permanent ellipsis, the amber identity rule is
  scoped to the official sibling popup's `role="tree"` container, and the
  catalogue wire type lives once (shared CatalogGroup).
- docs: bilingual README (zh authoritative / en mirror), LICENSE, AGENTS.md
  (branch model, versioning, release gates), upgrade runbook with the
  release-chain failure-recovery table, dont-do lessons list.
- publishing: GitHub Actions release (tag-triggered, npm publish) and CI
  (typecheck/test/build on node 22/24).

## 0.2.5 (2026-10-26)

- polish(child-window identity, per user review): the `#N · label` header
  chip and the header-utilities badge are gone — which subagent window you
  are in now shows by hovering the lineage title, which tints the plugin's
  amber identity color (a page-lifetime style on the renderer's documented
  `[data-slot]` anchor seam; no hashed official selectors, no !important).
  The composer-side badge (provider/model · effort) stays as the single
  in-window model readout; one-shot read-only child windows fall back to the
  transcript notice.
- polish(settings): the page description drops to the settings-General row
  description size (12px/18px label-secondary, DeveloperToolsRow precedent)
  instead of the Models-page intro size.

## 0.2.4 (2026-10-26)

- feat(badge): the child-window badge now also names the reasoning effort the
  request actually carried — a two-segment render mirroring the official
  model trigger (amber `provider/model` main segment, caption-colored effort
  segment that shrinks first, 240px cap with ellipsis; title/aria stay the
  single `provider/model · effort` string). No effort on the request keeps
  the badge exactly as before.
- feat(identity chip): entering a child window shows `#N · label` beside the
  header title — which subtask this window is, N being its position in the
  parent's child catalog order (official SubagentHeaderLineage data chain;
  tooltip `第 N / 共 M 个子任务`). Registered additively on
  `conversation.session.header.actions` (order -25, beside the official
  catalog action at -30); nothing on top-level sessions, and a
  not-yet-loaded parent catalog degrades to the label alone.

## 0.2.3 (2026-10-26)

- fix(list rows): the name-anchored popover could not be reached reliably —
  a 4px margin between the name and the popover was a dead zone that closed
  it (mouseleave fired) before the pointer crossed, and clicking the name
  toggled closed what hovering had just opened. The popover now sits
  flush against the name (no dead zone), a click PINS it open (pointer-down
  elsewhere closes; Escape closes), and the action buttons carry larger hit
  areas — hover → move → click lands on the first try.

## 0.2.2 (2026-10-26)

- polish(list rows): the ⋯ trigger is gone — hovering (or clicking) the
  model NAME itself now reveals a compact horizontal action popover, so the
  row is just index · name · effort. The popover adapts to the row position:
  first row shows 下移+移除, last row 上移+移除, middle rows all three —
  a boundary row never renders a dead action. Two two-char text buttons in
  one line replace the multi-row menu card.

## 0.2.1 (2026-10-26)

- polish(list rows): the three always-on row buttons (up / down / remove)
  collapse into one ⋯ trigger revealed on row hover (and keyboard focus);
  its menu carries 上移/下移 (boundary items disabled) and a destructive
  删除 — no more dead arrows on the first/last rows and no dedicated
  remove column.
- polish(effort select): the default row is now just「默认」/「Default」—
  the closed box shrinks accordingly; hovering it (or any selected value)
  explains what it resolves to, e.g. 跟随模型默认档位（当前：Low）.

## 0.2.0 (2026-10-26)

- **renamed to `dsh-subagent-plus`** (the dsh-browser-plus product naming;
  no official `-plus` semantics). The whole identity family moves together —
  package name, cordis patch row id/name, client bundle banner id, plugin
  name export, settings namespace, locale namespace — pinned by a new
  `tests/manifest.spec.ts`. Upgrading an installed profile requires the
  three-line migration (dependency key, bundles entry, patch row id/name —
  the config block is preserved verbatim); same-version `file:` reinstalls
  are skipped, hence the 0.2.0 bump.
- feat(effort): per-model reasoning-effort selects. Picking a route into the
  pinned row, the fallback row, or a candidate list row now loads that
  model's own effort levels from the host catalogue (off/low/medium/xhigh
  for qwen-style, low/high/max for zai-style, none for non-reasoning models)
  as a dropdown: an always-present "Default (<name>)" row (empty value keeps
  the key omitted, the host materialises the model default), the model's
  levels by name, and a visible stale option when a stored id falls outside
  the current set (never silently rewritten; runtime validation owns
  rejecting it). Clearing a route clears its effort; switching keeps the
  stored id only while the new model still supports it. The two free-text
  effort inputs left the Advanced fold.

## 0.1.6 (2026-10-26)

- feat(settings page): an independent settings section (设置 → 子智能体模型
  策略) replaces manual cordis.patch.yml editing — strategy picker (pinned /
  round-robin / random / priority), ordered candidate list (add / remove /
  move up-down, capped at 5), fallback-model card, and an advanced fold
  (respectExplicit, showNotice, pinForkChildren, failOpen, autoRoute,
  cooldownMs). Visual conventions mirror the official settings page
  (13px/500 labels, 34px inputs, hairline separators, ⓘ click-to-expand
  help, reversed primary save button); model options come from the host
  catalogue. Saves land in the same profile-patch layer as manual edits,
  atomically behind the shared config form's revision fence.
- feat(hot config): every editable field is volatile — a committed settings
  change reaches the next child request without restarting the plugin and
  without resetting the health table, rotation cursor, or sticky decisions
  (LivePinConfig read-time evaluation; a materialization failure keeps the
  last good configuration).
- feat(fallback): an optional fallback route (`fallbackProvider` /
  `fallbackModel` / `fallbackReasoningEffort`, empty = off), independent of
  the candidate list, used when no candidate is usable (all cooling or
  unregistered — also the "empty list, single fixed model" entry, and the
  pinned strategy's no-pinned-route case). Failover still prefers the next
  healthy candidate; the fallback participates in health tracking; its
  transcript notice is `[model fallback: …]`.
- feat(anti-brick, review P0): structural problems (>5 routes, half-filled
  or repeated priority entries) still refuse to load, while cross-field
  combinations a settings page could persist (priority strategy with an
  empty list, half-filled or duplicate fallback) degrade with a warning
  instead of throwing — a persisted combination can no longer brick the
  plugin on the next host restart. The settings page blocks both classes
  through the same shared validation before writing.
- fix(review P1): save() now survives a rejecting mutate (transport down)
  instead of stranding the saving state; request-error recording is fully
  inert while disabled; a pinned-route failure attributes to the pinned
  model, never to a same-provider fallback.
- packaging: `dsh.client.inject` adds `@deepseek-ai/dsh-client-ui-settings`
  and `@deepseek-ai/dsh-api-remotes` (the settings shell and remote faces);
  a lean composition without them fails the whole client half loud, the
  same trade-off dsh-websearch makes.
- polish(ui, same 0.1.6): interaction and layout aligned with the
  dsh-websearch section — every ⓘ is a hover tooltip (Tooltip primitive +
  question icon, `dsh.client.external` adds ui-primitives), selects are
  compact auto-width boxes, switches are 36×20 green-when-on at row right
  edges, the takeover switch moved to the page header (status text became its
  aria/title), and the assignment-strategy row merged into the bottom of the
  single model card (pinned form titles the card 钉定路由). Page renamed
  子Agent增强 / Subagent Boost; dead locale keys removed; zh/en parity kept.
  Follow-up pass merges everything into ONE card — the fallback row sits
  right below the assignment-strategy row, and Advanced folds at the card's
  bottom behind a right-edge chevron (default collapsed); advanced rows are
  single compact lines with the explanation only in the ⓘ tooltip (the
  duplicated hint paragraph under each title is gone).
  Third pass: the header ⓘ is gone (the description line already carries it),
  the fallback-effort input moved into Advanced (shown only when a fallback
  is set), route selects show short labels in a capped box with the full
  route on hover (browser-plus translate pattern), and the advanced fold's
  rows lost their dividers — the fold header keeps the one boundary line.
  Fourth pass unifies the row rhythm: the pinned-route select joins the card
  header's right edge (identical to the fallback row), the add-model row
  becomes label-left/select-right, and both reasoning-effort inputs
  (pinned and fallback) live only inside Advanced behind clear titles —
  the puzzling bare "留空 = 跟随模型默认" box is gone from the main card.

## 0.1.5 (2026-10-25)

- feat(strategy): multi-route selection engine. New config `strategy`
  (`pinned` default, `round-robin`, `random`, `priority`), `priority` (ordered
  candidate routes; empty falls back to the official allowed-model list in its
  stored order), `respectExplicit` (default false) and `cooldownMs` (default
  120000; 0 disables health tracking). A spread strategy decides a child's
  route once on its first request and keeps it for the child's lifetime; the
  next child draws the next route. `pinned` keeps the exact v0.1.x behaviour,
  so an unchanged configuration behaves identically.
- feat(failover): route health. `agent/request-error` failures are classified
  by Harness code — transient (RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/
  EMPTY_RESPONSE) cools the exact route, credential/quota codes cool the whole
  provider, NO_ADAPTER/UNSUPPORTED_REASONING_EFFORT cool the route, request-
  shaped failures are ignored. The listener always delegates, so the official
  retry plugin keeps every retry decision; a retried request lands on the next
  healthy candidate (`request/header` records the change) and new children
  skip cooling routes. Sticky failures end the current child as before and
  only steer later children (decision D-3).
- feat(notice): spread strategies emit `[model assigned: … (strategy: …)]`
  once per child and `[model reassigned: route X is cooling down (CODE); …]`
  after a failover; notices are de-duplicated per child.
- docs: `docs/strategy.md` (decision matrix, recipes, known limits),
  `docs/v0.1.5-strategy-plan.md` (approved execution plan).

## 0.1.4 (2026-10-25)

- style(badge): drop the border/background chrome and mirror the official
  model-selector trigger geometry exactly (13px / 28px / transparent), so the
  badge reads as a native sibling in the composer row. Differentiation now
  rides on the text color alone: the stable amber state token
  `--dsw-alias-state-warn-primary` marks "this child runs a pinned model"
  at a glance. Read-only cursor kept; link/accent blue deliberately avoided
  so the badge never reads as clickable.

## 0.1.3 (2026-10-25)

- feat(badge): client half — read-only pinned-model badge on
  `conversation.input.right` (beside the official model selector) and
  `conversation.session.header.utilities` (header fallback for one-shot
  read-only child windows). Data: durable `modelSelection` projection
  (`lastUsed`, folded from `request/header`); top-level sessions and sessions
  without a readable route render nothing. Requires a web-app-class
  composition (the client entry binds `slots` + `locale`; a composition
  without them fails the web boot loud).
- feat(autoRoute): zero-config install — with `provider`/`model` unset and
  `autoRoute: true` (default), each child request adopts the FIRST route of
  the official subagent model-selection settings when they are enabled. The
  official list is a per-call allowlist, not a priority order; taking its
  first entry is a deterministic default only. Explicit configuration always
  wins; Hosts without the service (base/headless compositions) pin nothing.
- fix(packaging): `@deepseek-ai/dsh-llm` moved from an exact runtime
  dependency to `peerDependencies` (`>=0.2.0-rc.1 <0.3.0`) — inside a dsh
  profile the import resolves to the Host runtime's own copy, so a single
  module instance is guaranteed across Host upgrades.

## 0.1.2 (2026-10-25)

- feat(notice): add a visible one-line pinned-model notice to each child
  agent's transcript (config `showNotice`, default on). Hooks `agent/pre-step`,
  reuses the official `model-selection`/`notice` message source so the desktop
  renders it with the product's own collapsed notice row — the model a child
  window runs is now visible at first glance instead of inferred. One notice
  per child per pin target; none for top-level agents or (by default) fork
  children.

## 0.1.1 (2026-10-25)

- fix(packaging): declare `dsh.bundle.patch` in package.json. Without it the
  official plugin manager reports "这个包没有声明组合包，不能作为插件管理" and its
  reconcile step drops the package from `dsh.profile.bundles` on the next
  manager operation, silently unloading the plugin (observed in the wild when
  a plugin-page click triggered reconcile).

## 0.1.0 (2026-10-25)

- Initial release: pin all delegated child agents (subagent delegations and
  Agent Teams teammates) to one configured LLM route via the `agent/request`
  waterfall; top-level agents untouched; fork children excluded by default;
  fail-open on unregistered routes.
