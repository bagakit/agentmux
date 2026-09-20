# `@agentmux/demand`

`@agentmux/demand` is the host-neutral filesystem fact store for AgentMux demands.
It has no Electron, React, Desktop, Core, or Runtime dependency. Callers always pass
an explicit directory; the package never treats the current working directory as a
store root.

```ts
import { openDemandStore } from '@agentmux/demand'

const store = openDemandStore({ root: '/path/to/demand-data' })
const receipt = await store.create({ title: 'Ship the editor', sessionIds: [] })
await store.linkSession(receipt.demand.id, 'session-id')
await store.addDecision(receipt.demand.id, {
  question: 'Which project owns this?',
  decision: 'AgentMux',
  rationale: 'It spans multiple sessions',
  actorId: null,
})
```

The store is `<root>/store.json` with schema `agentmux.demand-store.v1`. Mutations
use an in-process queue, an exclusive lock file, an `fsync`ed temporary file, and an
atomic rename. Corrupt snapshots and lock failures raise `StoreError` with `code`,
`phase`, and `path`; they never become an empty replacement.

The standalone `agentmux-demand` binary reads the same API. Pass `--root` (or set
`AGENTMUX_DEMAND_ROOT`) and use `list`, `show`, `create`, `update`, `link-session`,
`unlink-session`, `link-project`, `unlink-project`, `activity`, and `decision-log`.

Goals use the same durable owner. Agents submit `proposeAlignment(id, proposal)`
and `proposeGrounding(id, proposal)`, or CLI `propose-alignment` / `propose-grounding`
with `--id` and `--proposal <json>`. `update` also accepts `--alignment <json>` and
`--grounding <json>`. Proposals cannot provide revisions, submission identities or
acknowledgement timestamps. The owner generates those facts.

Hosts expose `confirmAlignment(id, expectedRevision)` and
`acceptGrounding(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps?)`
only through explicit human actions. Changed goals invalidate confirmation; changed
results invalidate acceptance. Same-content proposals retain acknowledgements.
Acceptance requires one known, evidenced result per current confirmed criterion;
remaining gaps require the explicit `acceptGaps` choice and stay recorded as gaps.
A locatable evidence reference does not claim that the owner verified its contents.

Browser clients consume the pure types, parsers and readiness helpers from
`@agentmux/demand/goals`; this subpath has no filesystem or UI dependency.
