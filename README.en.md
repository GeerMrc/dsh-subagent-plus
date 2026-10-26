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

## Toggle & uninstall

- **Plugin page switch**: Settings → Plugins → dsh-subagent-plus (writes `disabled: true` and hot-reloads).
- **Soft off**: the settings-page master switch or `enabled: false` (hooks fully inert; routing is byte-identical to official).
- **Uninstall**: remove on the plugin page — official subagent behavior resumes unchanged; this plugin is a layer on top, official behavior was never modified.

## Known limitations (summary)

Full list in [docs/strategy.md](docs/strategy.md) §5: strategy/list changes affect the next decision point only; sticky failures end the current child (later assignments avoid the route); the health table and rotation cursor are process-local (reset on restart, shared across windows); remote web sessions persist saves for the current session only; lean compositions without the settings/remote services fail the whole client half (badge included) loudly.

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
