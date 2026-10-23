# @agentmux/capsule

Capsule owns durable local static pages independently of a UI, Agent process, or
Browser view. Its portable entry exports domain contracts and strict wire parsers.
The `@agentmux/capsule/node` entry exports `NodeCapsuleOwner` and `CapsuleError`.
There is no Core, Electron, React, or Agent runtime dependency.

```ts
import { NodeCapsuleOwner } from '@agentmux/capsule/node'

const owner = await NodeCapsuleOwner.open({
  stateDirectory: process.env.CAPSULE_STATE!,
})
const published = await owner.call('capsule.create', {
  operationId: 'original-publication-operation',
  sourcePath: process.env.CAPSULE_BUILD!,
  storageMode: 'managed',
  mode: 'isolated',
})
const samePage = await owner.call('capsule.resolve', {
  capsuleId: published.record.capsuleId,
})
await owner.close()
```

Managed pages copy regular files into a pinned per-page version directory before
publishing an atomic record. Path pages retain their exact external directory.
Sources, publication, fixed loopback ports, config, interactions and original
operation receipts remain distinct facts. Updating defaults affects future pages;
existing records retain their identities, roots, modes and origins. Static assets
and explicit SPA navigation fallback are supported. Arbitrary backend execution
is outside this module.

Each page retains its original loopback port after owner or process restart. A
port conflict remains visible on that exact page until the original port becomes
available. Resolving retries the same port; it never silently changes the origin.
Missing sources, corrupt individual records and optional injection failures do
not stop healthy page services. The HTTP server accepts GET and HEAD only, checks
the exact loopback Host, refuses traversal and symbolic links, and exposes no
management API or Human authoring channel. Capsule is a browser-level isolation
boundary, not an OS sandbox for hostile local filesystem writers.

Mutations require an original operation ID; updates also require the observed
revision. The single owner uses a process-scoped native file lock, fsynced files,
atomic replacement and directory sync. Lost confirmations retain original pending
operations. Reconciliation confirms the original effect and durability rather
than replaying publication, deletion or Browser creation. Explicit managed
content deletion never deletes a path source. Readers can inspect an original
pending operation while a presentation adapter calls back into the owner.

Hosts may compose a presentation port and an optional HTML injection port. The
presentation port owns actual Browser and space identities; a headless owner
reports rendering unavailable while continuing to serve content. An injection
port is trusted Host code and must bind any App bridge to the exact Browser and
document. It must not expose generic RPC, Node or Electron authority. Without an
adapter, injected-mode records remain readable and report unavailable App
capabilities. Durable page requests and drafts cannot authenticate Human replies;
trusted Core input composition is required for reply delivery.

`pnpm --filter @agentmux/capsule test` exercises real HTTP, content publication,
CAS, four mode combinations, faults, process death and original-origin recovery.
`pnpm --filter @agentmux/capsule test:mutation` changes the actual listener to pick
a new port and proves the process-restart test rejects that mutation, then restores
the original source and build.
