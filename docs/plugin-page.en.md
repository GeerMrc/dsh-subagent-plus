# dsh-subagent-plus (subagent routing)

> Route every delegated child agent by strategy: pin one LLM route, or spread children over candidate routes (round-robin / random / priority) — with keyword mapping, capability-derived defaults, health failover, and a fallback.

## What it does

- **Candidate list** (≤5): your standby model routes, assigned per child by the chosen strategy
- **Team keyword mapping**: teammates whose names contain a keyword run that route; a 12-row cross-domain template derives by model capability (quality / build / verify families), re-ranked live as candidates change
- **Capability evaluations**: export a research task to any strong model, paste the scores back — they join the ranking (one-click clear returns to the bundled snapshot)
- **Health failover**: failed routes cool down and swap at the next step boundary; three-tier takeover (row model → remaining candidates → fallback)
- **Child badge**: each child's input shows its current route

## Turning it off

**The plugins-page toggle is this plugin's only off switch** — off restores the host's default routing for every child.

## Compatibility

DSH ≥ 0.2.2 (the `agent.model.select` channel); on earlier hosts routing stays inactive (one-time log notice).
