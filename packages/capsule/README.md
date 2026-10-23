# @agentmux/capsule

Capsule owns durable local static pages independently of a UI, Agent process, or
Browser view. Its portable entry exports domain contracts and strict wire parsers.
The `@agentmux/capsule/node` entry exports `NodeCapsuleOwner` and `CapsuleError`.
There is no Core, Electron, React, or Agent runtime dependency.

The independently installed `capsule-runtime` executable owns serving. Core may
load its fixed entry as an ordinary ctxmux Run; neither Core nor Desktop needs to
remain connected for published HTTP pages to stay available. Capsule does not
supervise, replace or restart its own process. The Run owner manages process
lifecycle, including explicit stop and a later authoritative replacement.

```sh
capsule-runtime serve --state-directory "$CAPSULE_STATE" --socket "$CAPSULE_SOCKET"
```

Both paths must be explicit absolute addresses in the serving Host's namespace.
The socket's parent must be a private real directory owned by that user, and the
socket is mode `0600`. A live listener or unrelated filesystem object is retained;
only an exactly observed stale socket may be removed. Remote loopback URLs and
source paths remain remote. This entry does not expose a public network bind,
tunnel or HTTP management channel.

```ts
import {
  capsuleRuntimeEntrypoint,
  connectCapsuleRuntime,
} from '@agentmux/capsule/runtime'

// Pass this installed absolute entry to the Run owner's prepared Node launch.
const entrypoint = capsuleRuntimeEntrypoint()
const client = await connectCapsuleRuntime({
  socketPath: process.env.CAPSULE_SOCKET!,
  expectedRuntimeId: process.env.CAPSULE_RUNTIME_ID!,
})
const identity = await client.identity()
const pages = await client.call('capsule.ls', {})
await client.dispose() // HTTP and the serving process remain available.
```

`runtimeId` is minted once into the original domain's `runtime.json`; an unreadable
identity is never silently replaced. `ownerInstanceId` is fresh for each serving
process, and `pid` is only an observation. `identity()` queries the original
connection, and `expectedRuntimeId` is checked before any business call. Existing
namespaces, records and content addresses are retained. An embedding that already
owns process lifetime may also use `startCapsuleRuntime({ stateDirectory,
socketPath })`; its explicit `close()` shuts down that service. Client `dispose()`
only releases that client.

The private versioned protocol validates every request, result and narrow adapter
callback. Frames carry a four-byte length and UTF-8 JSON with a 16 MiB per-frame
buffer limit. Oversized requests fail before sending or reserving an operation;
an oversized result is an unknown observation of its original effect, never an
invalid registry or permission to replay. Other connections and HTTP remain
available. The frame budget is unrelated to accumulated content or draft storage.

`connectCapsuleRuntime` optionally accepts `{ adapters: { presentation, replies } }`.
Callbacks belong to the exact original socket and pending call, retaining that
call's original context. Saved or wire `caller`/`principal` values provide
attribution, never Human authority; a reply adapter still needs its real native
confirmation and original Core input owner. Without an adapter, presentation or
trusted input is unavailable while page hosting and ordinary domain reads remain
usable. A call's `context.signal` cancels only its current observation, including
pending callbacks. Disconnect and reconnect never automatically replay a business
call, Browser open or input submission. Original pending effects can be inspected
through the newly connected client's narrow observation adapters.
An optional connection-level `signal` also cancels connect/handshake and every
later observation, including `identity()`, when a live listener stops responding.
Cancellation releases that connection without inferring process death or stopping
the original service Run. Callers choose their observation deadline.

The lower-level Node owner remains available for embeddings and focused domain
tests:

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

Each available endpoint also identifies its current HTTP owner lifetime with
`instanceId`; successful HTTP responses carry that same value in
`X-AgentMux-Capsule-Instance`. The value changes after owner replacement and is
neither a durable page ID nor an authority token. Browser adapters must correlate
the actual navigation response with the original owner observation rather than
infer loaded-document provenance from a reused origin.

Reply operation inspection projects its original reserved `inputOperationId`
from the existing operation effect, including while the trusted prepare callback
is running. The field is an identity correlation fact and supplies no input or
Human authority; no second reservation or persistent input field is created.

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
HTML adapter, injected-mode records remain readable without changing their bytes.
The HTTP owner does not infer whether a client provides a native document adapter;
actual App capabilities are discovered in that exact client document. A supplied
HTML adapter's failure remains an observable injection issue.
Durable page requests and drafts cannot authenticate Human replies. A Host may
compose the narrow reply port with its actual native confirmation and original
Core input owner. Preparation freezes the original request, answer, recipient,
Run and input ID before submission. The owner saves a dispatch boundary before
the first possibly executing call; unknown submissions are inspected using that
original input and never resent or retargeted. Saved principal and adapter metadata
are data, not authority. An unattempted durable preparation can continue only
through an explicit repetition of the same operation and a fresh trusted native
confirmation. Pending Browser opens similarly reconcile their original
presentation operation without opening a replacement. Unrelated page mutations
remain available while an external presentation or reply is pending.

`pnpm --filter @agentmux/capsule test` exercises real HTTP, content publication,
CAS, four mode combinations, faults, process death and original-origin recovery.
`pnpm --filter @agentmux/capsule test:mutation` compiles actual listener and HTTP
instance-header mutations in an isolated package copy and proves the original
process-restart and HTTP-response tests reject them. Shared source and compiled
artifacts remain unchanged.

`pnpm --filter @agentmux/capsule test:reply:mutation` uses the same isolated
compilation for original-input inspection and reserved-input visibility mutations;
the existing saved-reply and trusted-preparation tests must reject them.

`pnpm --filter @agentmux/capsule test:runtime` launches the installed serving entry
as a real independent subprocess, checks HTTP after client exit, original domain
and page recovery after process death, concurrent callbacks, cancellation, trusted
reply observation and strict transport boundaries. `test:runtime:mutation`
compiles actual production source mutations in a temporary isolated package and
proves the original-call and durable-domain identity tests reject them. Shared
source and compiled artifacts are never replaced by those runtime mutations.
