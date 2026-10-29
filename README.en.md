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
| Official-page takeover | While enabled, the official "Subagents" settings page is hidden; the **runtime limits** live at the top of the same card as the candidate list (takeover statement in the limits ⓘ tooltip), one Save commits the official and plugin namespaces in a fixed order (single source of truth); the candidate list is the complete replacement of the official model selection; the header switch is the full takeover switch (off = plugin disabled, official page restored with values intact) |
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

Restart the desktop app → Settings → Subagent Boost: the default "pinned + auto-adopt the official allowlist's first entry" works out of the box.

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
    enabled: true            # master switch; off fully restores official behaviour
    strategy: round-robin    # pinned | round-robin | random | priority
    priority:                # candidate routes (≤5, order = priority; empty uses the official allowlist)
      - { provider: sz, model: Qwen3.8-27B-FP8, reasoningEffort: "" }
      - { provider: hh, model: Qwen3.8-27B-FP8, reasoningEffort: xhigh }
    fallbackProvider: ""     # fallback route (paired with fallbackModel; empty = off)
    fallbackModel: ""
    respectExplicit: false   # true = respect explicit per-call selections
    cooldownMs: 120000       # failure cooldown; 0 disables health tracking
    showNotice: true         # one transcript notice per child
```

Full semantics: [docs/strategy.md](docs/strategy.md) and [docs/settings.md](docs/settings.md).

## Takeover semantics (v0.3.0+; refined in v0.3.1)

- **Installed and enabled = takeover**: the official "Subagents" settings page (a pure edit surface) is hidden; its **runtime limits** (max recursion depth / parallel cap — still enforced by the official subagent runtime at delegation time; this plugin does not re-implement them) are edited from this plugin's settings page **through the same keys**: what you write is the official namespace value. Since v0.3.2 the limits sit at the **top of the same card as the candidate list** (the official SubagentCard single-card precedent: in-card sections separate by whitespace, not borders; the takeover statement rides the limits ⓘ tooltip). **One Save button** commits in a fixed order (limits → plugin config); a failing namespace is named in the footer, and a namespace that goes unserved only blanks its own section and is excluded from the save (no deadlock while taken over).
- **The candidate list is the complete replacement of official model selection (v0.3.2, ADR 0003)**: strategy + per-model effort + fallback + health-aware cooldown already cover and exceed the official allowlist; the official allowlist **has no editing face** — the host half keeps only read-only bridges (auto-adopting its first entry with an empty pinned route; the fallback pool when the candidate list is empty). Known boundary: users on `respectExplicit=true` who need to curate the official allowlist should temporarily disable this plugin (the official page returns) or hand-edit the profile patch.
- **The header switch is the full takeover switch (v0.3.1)**: turning it off goes through a confirm bar (spelling out that this page unloads and re-enabling lives on the Plugins page); confirming disables the whole plugin through the plugin manager (bundle level) — the official "Subagents" settings page returns with every value intact. Production desktop/remote hosts apply it via hmr immediately; startup-profile hosts show a restart-required notice. The switch mirrors the bundle state and stays in sync with the Plugins page toggle. Compositions without the plugin-manager face degrade to a hint pointing at the Plugins page instead of a dead settings entry.
- **Disable / uninstall = restore**: after the Plugins page toggle (or uninstall, or the confirmed header switch) the official page returns (hmr on production hosts; source-launched hosts need a restart) with the values intact. Existing child agents return to official resolution from their **next request**; in-flight requests are unaffected.
- **Transparency & escape hatch**: the takeover is visible in the plugin page's overrides list; a user-layer patch `{id: ui-settings-subagent, disabled: false}` restores the official page at any time.
- Only the edit surface is hidden: the `subagent` runtime row and the `subagent-model-selection-settings` service row are never touched (official presets hard-depend on the latter; disabling it removes the delegation tool itself).

## Toggle & uninstall (v0.3.1)

- **Header takeover switch** (top-right of Settings → Subagent Boost): confirmed, it disables the plugin at bundle level and restores the official page; this settings page unloads with the plugin. Re-enable from the Plugins page.
- **Plugin page switch**: Settings → Plugins → dsh-subagent-plus main toggle (the same bundle state as the header switch, synced both ways).
- **Pause route assignment only** (first item in the Advanced fold, the former soft switch `enabled: false`): hooks fully inert, routing byte-identical to official; **the page takeover stays** (the official page remains hidden) — use the takeover switch, the plugin-page switch, or uninstall to restore it. A v0.0.2 `enabled: false` keeps its exact meaning after the upgrade.
- **Uninstall**: remove on the plugin page — the official "Subagents" settings page and official routing both return.

## Upgrade & version line (v0.3.1)

- npm carries **0.3.0** (published 2026-10-28 by a tag push minutes before the mandatory user real-test gate existed; `latest` was moved back to 0.0.2). The line continues at **0.3.2** (0.3.1 was an unreleased local iteration, folded into this version); `tests/manifest.spec.ts` enforces the published floor. Upgrading from 0.0.2 changes no config fields — the header switch's meaning moves (the former soft switch now lives in Advanced), the official "Subagents" settings page becomes hidden by the takeover, and every stored value stays compatible.

## Known behaviour & limitations (summary)

Full list in [docs/strategy.md](docs/strategy.md) §5: strategy/list changes affect the next decision point only; sticky failures end the current child (later assignments avoid the route); the health table and rotation cursor are process-local (reset on restart, shared across windows); remote (non-loopback) web sessions cannot reach the settings namespaces at all (the official memory persistence skips the mirror — sections turn unavailable) while the takeover switch keeps working; lean compositions without the settings/remote services fail the whole client half (badge included) loudly.

**Deliberate deviation from official semantics (v0.3.0+)**: when a child's route is changed, the `maxTokens` inherited from the parent is **dropped** (official per-call model selection retains it) — the inherited budget is sized for the parent's model and can overflow the new model's limit, and the official runtime performs no clamping; once dropped, the runtime materialises the new model's default. Consequently an explicitly configured parent output budget does **not** propagate to rerouted children.

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
