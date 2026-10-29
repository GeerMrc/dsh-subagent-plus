# dsh-subagent-plus

> Language authority: this file is a mirror of [README.md](README.md) (Chinese); when the two disagree, the Chinese version is authoritative.

A standalone cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) providing a **child-agent model-routing strategy engine**: assign every delegated child agent to an LLM route by configurable strategy, with a read-only model badge and a settings page. No product code is modified; immune to upstream upgrades.

## Feature matrix

| Capability | Description |
|---|---|
| Pinned | Every child agent uses one fixed route (the default; closes the official gap where an omitted per-call selection silently inherits the main model) |
| Round-robin | Each child takes the candidate list in order (a→b→c→a…) and keeps its route for its lifetime |
| Random | Each child draws randomly and keeps it |
| Priority | First healthy route by default; degrades down the list while a route cools down after failures, recovers automatically |
| Fallback | The last-resort route when every candidate is unusable or the list is empty (optional; empty list + fallback = the single-model entry) |
| Reasoning effort | Per-model effort dropdowns load each model's own levels (qwen-style Off/Low/Medium/Xhigh, zai-style Low/High/Max; non-reasoning models show none) |
| Health failover | Transient failures (rate limit / 5xx / timeout / network) switch the official retry to the next healthy route; credential/quota failures cool the whole provider and steer later assignments |
| Read-only badge | Beside the child window's composer: `provider/model · effort` (two-segment coloring, full text on hover) |
| Child-window identity | Inside the sibling-switcher popup, the row of the child you have open tints amber (layered on the official bold marker) |
| Settings page | Settings → Subagent Boost: strategy / list (≤5) / fallback / advanced, fully graphical; saves hot-apply (no restart, no runtime-state reset) |
| Official-page takeover | **Installed = 100% takeover, binary (ADR 0005)**: the official "Subagents" settings page is hidden, the **runtime limits** live at the top of the same card as the candidate list (takeover statement in the limits ⓘ tooltip), one Save commits the official and plugin namespaces in a fixed order (single source of truth); the **candidate list is the sole routing source** (the official allowlist is never read); the only off switch is the Plugins page toggle (official page restored with values intact) |
| Coverage | `subagent` delegations, Agent Teams teammates, delegations inside resumed sessions; top-level agents and (by default) fork children unaffected |

## Install from scratch (three steps)

```sh
# 1) Build the tarball
pnpm install && pnpm run pack:artifact   # produces dist-artifacts/dsh-subagent-plus-<ver>.tgz

# 2) Install into a DSH profile (desktop is the desktop app's reserved profile)
dsh plugin --profile desktop add /path/to/dsh-subagent-plus/dist-artifacts/dsh-subagent-plus-<ver>.tgz

# 3) Verify
dsh --profile desktop --dump-config | grep dsh-subagent-plus
```

Restart the desktop app → Settings → Subagent Boost: install takes over the edit surface immediately; until you configure routes nothing is assigned (children inherit the parent session's model) — pick a model in the pinned route or candidate list, the page states the not-assigned state plainly.

### Other distribution channels

- **npm**: `dsh plugin --profile desktop add dsh-subagent-plus@<ver>`.
- **file: dependency**: edit the profile `package.json` (`"dsh-subagent-plus": "file:…tgz"` plus the same name in the bundles array) — equivalent to `dsh plugin add`; see [docs/upgrade.md](docs/upgrade.md).
- **From source**: clone and run the three steps above.

## Configuration at a glance

Everything is editable on the settings page; the equivalent profile-patch layer:

```yaml
- id: dsh-subagent-plus
  name: dsh-subagent-plus
  config:
    strategy: round-robin    # pinned | round-robin | random | priority
    priority:                # candidate routes (≤5, order = priority) — the sole routing source; an empty list assigns nothing (children inherit the parent session's model)
      - { provider: sz, model: Qwen3.8-27B-FP8, reasoningEffort: "" }
      - { provider: hh, model: Qwen3.8-27B-FP8, reasoningEffort: xhigh }
    fallbackProvider: ""     # fallback route (paired with fallbackModel; empty = off)
    fallbackModel: ""
    respectExplicit: false   # true = respect explicit per-call selections
    cooldownMs: 120000       # failure cooldown; 0 disables health tracking (UI cap 86400000)
    showNotice: true         # one transcript notice per child (bilingual zh + en line)
```

Full semantics: [docs/strategy.md](docs/strategy.md) and [docs/settings.md](docs/settings.md).

## Takeover semantics (v0.0.3+, binary — ADR 0005)

- **Installed = takeover, binary**: the official "Subagents" settings page (a pure edit surface) is hidden; its **runtime limits** (max recursion depth / parallel cap — still enforced by the official subagent runtime at delegation time; this plugin does not re-implement them) are edited from this plugin's settings page **through the same keys**: what you write is the official namespace value. Since v0.0.3 the limits sit at the **top of the same card as the candidate list** (the official SubagentCard single-card precedent: in-card sections separate by whitespace, not borders; the takeover statement rides the limits ⓘ tooltip). **One Save button** commits in a fixed order (limits → plugin config); a failing namespace is named in the footer, and a namespace that goes unserved only blanks its own section and is excluded from the save (no deadlock while taken over).
- **The candidate list is the sole routing source (ADR 0005)**: strategy + per-model effort + fallback + health-aware cooldown cover and exceed the official allowlist; the official allowlist **has no editing face and is never read at runtime** (it does not constrain this plugin's candidates either — a candidate only needs to be registered in the LLM catalogue). No route configured (empty pin, empty list, no fallback) = nothing assigned: children inherit the parent session's model.
- **Disable / uninstall = restore (the only off switch is the Plugins page toggle)**: after the Plugins page toggle (or uninstall) the official page returns (hmr on production hosts; source-launched hosts need a restart) with the values intact. Existing child agents return to official resolution from their **next request**; in-flight requests are unaffected. There is no switch inside the settings page — turning the plugin off happens on the Plugins page only.
- **Transparency & escape hatch**: the takeover is visible in the plugin page's overrides list; a user-layer patch `{id: ui-settings-subagent, disabled: false}` restores the official page at any time.
- Only the edit surface is hidden: the `subagent` runtime row and the `subagent-model-selection-settings` service row are never touched (official presets hard-depend on the latter; disabling it removes the delegation tool itself).

## Toggle & uninstall (v0.0.3, ADR 0005)

- **The Plugins page switch is the only switch**: Settings → Plugins → dsh-subagent-plus main toggle. Off = the plugin disabled at bundle level, the official page restored with values intact; re-enable in the same place.
- **Uninstall**: remove on the plugin page — the official "Subagents" settings page and official routing both return.
- **No in-page switches**: neither the former "pause route assignment" soft switch nor the header takeover switch exists (v0.0.3, ADR 0005). To stop routing temporarily, clear the strategy/list/fallback — the not-assigned state keeps the edit-surface takeover.

## Upgrade & version line (v0.0.3)

- The product line stays on **0.0.x** (0.0.2 → 0.0.3 → …, user ruling, ADR 0004); the npm 0.3.0 package is an orphaned accidental publish from 2026-10-28 (tag deleted, `latest` still 0.0.2) and is not part of the line. Versions advance only on user-approved releases; day-to-day polish rides regular commits.
- **Three behaviour flips upgrading from 0.0.2 (ADR 0005, all user-ruled)**: (1) a persisted `enabled: false` (paused) flips to full takeover — the field is gone and residue keys are ignored; (2) an empty pinned route that relied on autoRoute adopting the official allowlist's first entry now assigns nothing (children inherit the parent session's model); (3) round-robin/random with an empty list no longer falls back to the official pool — no candidates (fallback or inheritance). Edge case: a hand-edited `enabled: false` with structurally invalid routes now refuses to load instead of loading inert. Stored valid values stay compatible; residue keys merge through, are ignored, and are never written back.

## Known behaviour & limitations (summary)

Full list in [docs/strategy.md](docs/strategy.md) §5: strategy/list changes affect the next decision point only; sticky failures end the current child (later assignments avoid the route); the health table and rotation cursor are process-local (reset on restart, shared across windows); remote (non-loopback) web sessions cannot reach the settings namespaces at all (the official memory persistence skips the mirror — sections turn unavailable); turn the plugin off from a local Plugins page (the accepted cost of dropping the in-page switch, ADR 0005); lean compositions without the settings/remote services fail the whole client half (badge included) loudly.

**Deliberate deviation from official semantics (v0.0.3+)**: when a child's route is changed, the `maxTokens` inherited from the parent is **dropped** (official per-call model selection retains it) — the inherited budget is sized for the parent's model and can overflow the new model's limit, and the official runtime performs no clamping; once dropped, the runtime materialises the new model's default. Consequently an explicitly configured parent output budget does **not** propagate to rerouted children.

## Naming conventions (first-party standalone plugins)

- Bare `dsh-<product>` as the package name (no `@deepseek-ai` scope — upstream-reserved); if npm policy rejects the bare name, distribute under a scope plus a bare-name tarball (dual-name mode).
- The registration-id family stays identical to the bare package name: package name = cordis patch row `id` = row `name` = client bundle banner id = plugin `name` export = settings/locale namespace; pinned mechanically by `tests/manifest.spec.ts`.
- Suffixes like `-plus` are product names, not mechanism semantics; CSS prefixes / `data-*` short names (`dsmp-` here) are layered separately from registration ids.
- Any change touching the install surface (renames included) must bump the version: same-version `file:`/tarball reinstalls are skipped by pnpm.

## Development

```sh
pnpm run typecheck   # both tsconfigs
pnpm test            # full suite (host + client pure logic)
pnpm run pack:artifact
```

Branch model, versioning, and release flow: [AGENTS.md](AGENTS.md); upgrades and release-chain recovery: [docs/upgrade.md](docs/upgrade.md); negative-lessons list: [docs/dont-do.md](docs/dont-do.md).

## License

[MIT](LICENSE)
