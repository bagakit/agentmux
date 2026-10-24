# AgentMux connectors

`@agentmux/connectors` is an optional executing-Host package. Core consumes its
`ConnectionPort` through `AgentMuxRpcServiceOptions.connections`; Core has no
reverse dependency on this package, an adapter SDK, Electron or React.

## Connection ownership

`ConnectionHost` owns connection configuration and its original configuration
operations in SQLite. Configuration and operation receipt commit together. A
connection's application domain, App ID and adapter identity cannot be reassigned;
credential references, labels and enabled state can change with an exact revision.
Reusing an operation ID returns its original receipt only for the original input.
An operation inspection also reads the current connection, so an old receipt does
not conceal a later credential rotation.

Pass `database` to share one executing Host database with other connector owners,
or `databasePath` for a connection owner that opens and closes its own database.
The database uses WAL and full synchronous commits. Each owner keeps its own
named tables; Core Agent history, input, permissions and runtime state remain with
their original owners.

`SecretPort.resolve` returns a credential only to the executing adapter.
`ConnectionSecrets` reuses the original SQLite table, operation IDs, opaque
references and transactions. New values have an explicit format marker followed
by UTF-8 in the private Host database: permission-protected plaintext, with a
current-user 0700 directory and 0600 database/SQLite sidecars. No OS key service,
key file, alternate store or fallback is required. Unsupported original ciphertext
is retained unchanged; inspection reads its reference, while resolution or a
same-operation write refuses that exact unsupported value without conversion.

Public configuration, operation results and diagnostics contain only an opaque
`credentialRef`. The dedicated `connection.credential.store` transient input is
restricted to the original authenticated person/device, exact Runtime fence and
protected Unix/SSH-to-Unix/end-to-end relay transport. CLI entry uses stdin alone.
`connection.credential.inspect` returns the original reference, including after an
unknown commit acknowledgement. Managed Agents cannot administer credentials.
Adapter exceptions are reduced to safe stage reasons because raw platform errors
can contain credentials. See [Host credential storage](../../apps/host/credential-storage.md)
for the exact entry, permission and original-operation contract.

## Connector service policy

The original `ConnectionHost.service` owns one endpoint-wide enabled/revision
policy in the same SQLite database. Its strict public types and result validation
are defined in [the Core service contract](../core/src/connection-service-contract.ts)
and [codec](../core/src/connection-service-codec.ts). An accurately absent row means
enabled at revision zero; storage uncertainty cannot supply that default.
Service schema failures stay local to this policy and preserve application
management and existing receiver/publication lanes.

```sh
amux connection service get
amux connection service configure --input service-policy.json
amux connection service inspect --operation-id connector-off
```

For example, after reading revision zero, the configure input is
`{"operationId":"connector-off","expectedRevision":0,"service":{"enabled":false}}`.
A saved receipt remains inspectable after later changes or owner restart. Retain
that exact input after a lost reply; current policy does not acknowledge the
original operation. Service and application configure share the original
configuration operation index and reject cross-method operation ID reuse.

Desktop Settings → Mods → Agent Conversation Connector exposes the same policy
through [the original settings module](../../apps/desktop/src/renderer/src/components/settings/modules/connections.tsx).
Edit **Enable Agent Conversation Connector**, then choose **Save Connector service**.
**Check current service** reads current policy; **Original service requests** keeps
each submitted input and provides **Check original request** for its historical
receipt. A new choice can explicitly use the current revision while earlier
requests remain available. Read failures keep the last confirmed menu policy and
leave application management reachable. The original Region context menu and
Agent header menu show or withdraw one named Connector group together.

Off prevents new automatic intake and publication without rewriting application
enabled values, Bindings, grants, source cuts, retained inputs or delivery progress.
An unclaimed received message stays received and continues with the same ingress
identity after enable. Claimed input with no Core receipt and unknown external
effects remain inspect-only. An original enabled Core wait requires explicit
rejoin under current authority; a positively not-applied publication requires its
original explicit retry. Already started effects may settle their same attempt
while off. Read-only recovery, application management and ordinary local Agent
input remain available.

## Public consumers

The SDK, CLI and Desktop Settings use the same public service:

```sh
amux connection ls
amux connection inspect --connection application-connection
amux connection configure --input connection.json
amux connection inspect --operation-id configuration-save
amux connection test --connection application-connection
```

The configure input is a complete reference-only value:

```json
{
  "operationId": "configuration-save",
  "expectedRevision": null,
  "connection": {
    "connectionId": "application-connection",
    "adapterId": "application-adapter",
    "application": { "domain": "chat.example", "appId": "application-id" },
    "label": "Team application",
    "enabled": true,
    "credentialRef": "secure-credential-reference"
  }
}
```

For updates, read the original connection and use its exact `revision`. After an
unknown save response, inspect the same `operationId` before changing its input or
identity. Configuration administration requires the public service's actual
transport-approved user or device; an Agent cannot claim that principal in JSON.

A headless embedding injects the owner into the existing semantic Runtime:

```ts
import { ConnectionHost } from '@agentmux/connectors'
import { startHeadlessAgentMux } from '@agentmux/core/headless-runtime'

const connections = new ConnectionHost({ databasePath, secrets: secureResolver, adapters })
const runtime = await startHeadlessAgentMux({ service: { connections } })
// The embedding owns both lifetimes. Stop the Runtime, then close its connections.
await runtime.stop()
connections.close()
```

Desktop contributes **Chat applications** to the existing **Connections** Settings
group. Its trusted credential-entry IPC is separate from the public reference-only
connection methods. The Settings component reconciles the original operation after
a lost save response rather than creating a second connection.

The original Agent Region menu consumes the same public room and Binding methods.
It creates a dedicated group or explicitly selects an existing group, then confirms
sharing separately. Another Region displaying the same Host/Session reads the same
Binding. Actor approval, member inclusion and platform delivery remain separate
facts; their behavioral contract is defined in
[the conversation design](../../docs/design/behavior/conversation-mode.md#共同对话协议与外部交流入口).

Desktop retains only the exact submitted request and operation correlation in its
existing workbench persistence. Reopening a form reads original Core/Host receipts;
an unknown effect has no fresh-create or retry action. The original Composer reads
its own Session's audiences and retains the last known audience during an observation
gap. Group details read bounded delivery pages and original operations without
retrying them. Configuration alone does not certify delivery; results are shown per
group. Local drafts, native input and execution lifetimes stay with their original
owners.

## Independent service facts

Authentication, transport, durable receiving and group delivery have independent
observations. Saving configuration does not check authentication. An adapter test
does not imply that receiving or delivery has started. Missing adapters, missing
credentials and unconfirmed checks remain explicit. A late check cannot certify a
newer configuration revision. Restart retains configuration and operations while
previous in-memory service observations return to unknown.

Connection storage failure remains local to the connection service and does not
stop healthy Agents or replace their Sessions.

## Durable room creation

`RoomProvisioningHost` borrows `ConnectionHost.database`, its configured adapter
registry and the original Core spatial read port. Attach its `create` and `inspect`
methods to `connections.rooms`, preserving that original port's discovery methods;
Desktop composes this port alongside its original binding owner. The public SDK
and CLI use the same Host owner:

```sh
amux connection room create --input room.json
amux connection room inspect --operation-id create-team-room
```

The create input freezes `operationId`, `connectionId`,
`expectedConnectionRevision`, `executionHostId`, `agentSessionId`,
`regionAnchor`, `name` and `members: [{idType, userId}]`. The configured connection
supplies its application and adapter identity. Only the transport-approved current
user or device can administer these operations; JSON cannot declare that authority.
Creation grants no Binding, history sharing, actor capability or Agent input.
Choose sharing scope separately through the original `connection bind` operation.

Intent is durable before credential resolution. Each creation or member-addition
attempt is committed before its adapter call; its receipt is saved separately.
The adapter receives credentials only through the original Host resolver. A known
room ID survives partial member failures and any later binding failure. Empty
membership still retains the exact created room. Inspect only reads saved facts;
it does not resolve credentials, query by room name, add members or retry an effect.
After a missing response or owner restart, inspect the original operation. Unknown
and dispatched attempts remain inspect-only. An exact original explicit create can
continue a pending phase only when no attempt has been dispatched. A known
creation non-application allows a new explicit operation; it does not replay the
old receipt. Member non-application has no implicit retry.

One Connection, execution Host and Session retain their original room claim across
Regions and operation IDs. Another operation reports that original identity;
only confirmed creation non-application releases the claim. Configuration or exact
Region occupant changes refuse the pending effect while preserving local Agents.
Unrelated spatial changes do not invalidate an otherwise exact target.

`RoomProvisioningAdapter.create` and `addMembers` are independent effect leaves.
They receive a detached original `ConnectionConfig`, original operation and
distinct attempt IDs. Credentials stay a separate argument from the original
Host resolver. `RoomProvisioningCallContext` can carry the original caller's
abort signal through the private adapter and SDK; no signal or authorization
callback is accepted through JSON. Cancelling an already claimed effect retains
its original durable operation and any confirmed room or member results.
Creation returns an exact room ID, authoritative non-application or unknown;
member results must match every original typed member. An adapter must qualify its
platform key, failure and partial-member semantics against the native contract.
Controlled adapter tests establish the generic Host boundary only.

## Room discovery and joining

The original ConnectionHost exposes `connection.room.ls`, `search`, `get` and
`members` through the same typed SDK, RPC and compiled CLI. Reads require the
exact `connectionId` and `expectedConnectionRevision`; the Host resolves its
original credential and rejects a late page from a changed configuration. No
Agent, spatial binding, Runtime, membership change or sharing link is created by
a read. Names identify choices visually and never route operations.

```sh
amux connection room ls --connection team --revision 1 --limit 20
amux connection room search --connection team --revision 1 --query Project
amux connection room get --connection team --revision 1 --room original-room
amux connection room members --connection team --revision 1 --room original-room
```

Use each returned opaque `next` cursor for the same original query and revision.
An unavailable or unknown observation is distinct from a confirmed empty page.
The Feishu list is the bot's joined rooms; search also includes rooms visible to
that application. Partial group information retains unknown fields. The official
member API returns platform user accounts and filters bots; a same-join batch can
exceed `page_size`. The leaf retains that complete page within the original RPC
wire budget, without cropping or inventing another cursor. Platform accounts do
not establish the local creator, human identity or an Agent chat grant.
[List rooms](https://open.feishu.cn/document/server-docs/group/chat/list.md),
[Search visible rooms](https://open.feishu.cn/document/server-docs/group/chat/search.md),
[Read a room](https://open.feishu.cn/document/server-docs/group/chat/get-2.md),
[Read members](https://open.feishu.cn/document/server-docs/group/chat-member/get.md).

An explicit `connection.room.link.create` accepts
`{operationId,connectionId,expectedConnectionRevision,externalConversationId}`
from a current trusted user or device. It records the exact original intent in
the same database before one native request. `connection.room.link.inspect`
only reads that original operation. Unknown requests stay inspect-only across
Host restart; there is no supported lookup by a platform deduplication key, and
inspection does not issue another link. A reused operation cannot change rooms.

The Feishu leaf uses the official `chat.link` API with `week` validity and keeps
the actual returned expiry in Unix seconds. A confirmed receipt only proves
that this link was issued. It does not prove the link is still usable, that a
person joined, or that membership and a chat grant exist. The bot must be in the
group; platform sharing settings, administrator restrictions and tenant rules
still apply. Disabling the bot or removing it from the group invalidates its
links. When no local-to-platform identity is proven, this official joining path
avoids guessing a creator ID. Creation, invitation, membership, Binding and
sharing remain separate original facts.
[Official sharing-link contract](https://open.feishu.cn/document/server-docs/group/chat/link.md).

The default Desktop composition delegates these methods to the original owner
and lazy official SDK adapter. Controlled SDK transport tests consume the real
Host, protected RPC and compiled CLI; they do not certify live credentials,
actual member access or a real group. Full GUI acceptance belongs to the consuming
journey using this same port.

## Room bindings

`RoomBindingHost` borrows a `ConnectionHost`, the original Core spatial read port
and an exact Host-to-Core checkpoint function. Attach it as `connections.bindings`
before exposing that connection port through the existing public service. Desktop
composes these ports from its original spatial owner and original Host clients;
headless embeddings supply those same ports. The binding owner uses
`connections.database`, including for synchronous reads joined by later delivery
transactions. It does not create another semantic Runtime or copy topology.

Public types and strict parsers are exported from `@agentmux/core/connections`;
their owning definitions are [the binding contract](../core/src/room-binding-contract.ts)
and [codec](../core/src/room-binding-codec.ts). Administration requires an actual
transport-approved user or device, never an author identity supplied in JSON.

The publication scope is an original consent fact. Existing
`future-native-user-facing` bindings keep assistant speech; broader
`future-shared-conversation` consent requires an explicit relink, exact expected
revision and fresh source cut. Reading or reusing an existing binding cannot
expand its scope. The same Outbox freezes scope before dispatch, retaining old
pending and unknown effects. The broader consent choice does not by itself
qualify native public content, a sender identity, media or complete parity.

After that explicit shared cut, original Core-captured public input is relayed
with its recorded human, Agent, external or unknown author. The same outbox
retains each exact content reference and freezes `relay.sender: application`
with the original target before dispatch. Feishu renders it as a read-only
amux relay card; ordinary Agent speech keeps its existing format. The original
delivery SDK and CLI expose those typed source facts without body or credentials.
This is application relay, not platform personal-send authority. It does not
qualify missing native user spans or complete full-conversation coverage.

When broader sharing reaches native user content without a qualified public
boundary, or an image/file the adapter cannot deliver completely, `connection
delivery ls` reports `unavailable` with reason `content-unconfirmed`. The original
source cut and pending work remain intact across worker restart. Unsupported
content is never silently skipped to report ready; local conversation and input
remain available. Already admitted pending work still proceeds, and original
effect inspection cannot overwrite the content-gap observation. Inspect the
original delivery separately to reconcile an older unknown effect. The existing assistant-speech scope retains its original
coverage.

```sh
amux agent conversation checkpoint --host local --session original-agent
amux connection bind --input binding.json
amux connection binding inspect --operation-id bind-team
amux connection binding ls --host local --session original-agent
amux connection binding pause --input pause.json
amux connection binding relink --input relink.json
amux connection grant --input grant.json
```

A new binding input names the exact execution target, current Connection revision,
original Region and native source. For example:

```json
{
  "operationId": "bind-team",
  "bindingId": "team-binding",
  "connectionId": "application-connection",
  "expectedConnectionRevision": 1,
  "executionHostId": "local",
  "agentSessionId": "original-agent",
  "regionAnchor": { "regionId": "original-region" },
  "externalConversationId": "room/project-alpha",
  "expectedSource": { "providerId": "provider", "nativeSessionId": "original-native" },
  "scope": { "input": "mentions-and-replies", "publication": "future-native-user-facing" }
}
```

Use the actual source returned by the original conversation checkpoint. The
initial cut excludes all existing history; binding does not share old questions
or records. Unsupported or changed sources refuse this new sharing boundary while
retaining the original Agent and connection. External conversation and actor IDs
are bounded opaque issuer values; an adapter owns any native syntax restriction.

The owner records the original operation intent before asynchronous Core reads.
It then rechecks the exact original Host, Session and Region before a synchronous
transaction saves the immutable binding, current mapping and applied
operation together. No SQL transaction spans an await, and no cross-database
atomicity with Core is claimed. An unrelated spatial revision does not invalidate
an unchanged target. A `preparing` receipt confirms intent only. After
an unconfirmed response, inspect and reconcile the same operation, input and
transport authority; an applied operation always returns its original saved cut.

The execution route consists only of `executionHostId` and `agentSessionId`.
`regionAnchor` provides navigation and never resolves a later occupant for
publication. Another Region for the same Connection and Session reuses the
existing binding, audience and cut. Each application and external conversation
has one current mapping. A different audience, occupant or native source needs
explicit relink with the current Binding revision and a fresh cut. The old
revision remains readable with `connection binding inspect --binding ID --revision N`.

Pause creates an immutable paused revision for future admission and publication;
it does not stop the Agent, close its display or rewrite an already dispatched or
unknown operation. Continuing requires explicit relink, even to the same target
and audience, so work accumulated while paused does not silently become eligible.
`readExact`, `readCurrent` and `publicationAuthority` let delivery owners read the
original audience and current authorization in their existing SQLite transaction.
An old unknown operation remains available for readonly reconciliation even when
its binding is no longer current.

A grant names the exact Binding revision, application, external conversation,
actor `idType` and actor `userId`. Its own revision is separate from the Binding
revision. `input`, `answer` and `permission` are independent capabilities; neither
membership nor attribution grants them. Publication authority comes from the
trusted user or device that authorized this Binding. Grant changes keep immutable
prior revisions. A later Binding revision carries current member decisions only for
the same application, group, execution Host/Runtime, Agent Session and input target.
Explicit trigger or publication changes preserve these decisions, including revocations;
changing authorization subjects never transfers grants. Original frozen references
remain bound to their original revisions.

`ApplicationAccessHost` keeps application rules in the same original connection
database, independent of whether any group has been bound. Rules are keyed by the
exact adapter, native application and actor namespace; another bot or hosting
owner does not inherit them. The public `connection.application.access` get,
configure and inspect methods retain original operation identity and revision CAS.
They require the authenticated person or device, not an external card or managed
Agent. Rules do not change Mote private-chat quotas.

Current `connection.binding.inspect` exposes member `access` separately from
persisted room grants. The effective resolver uses the complete local decision
when present, then the application rule: omitted local capabilities and local
revocations cannot be filled from application defaults. An old same-subject local
decision remains visible for review without reviving it. Explicit
`connection.binding.member.inherit` releases only the local head projection and
keeps immutable decisions and operation receipts. History is not a second routing
head. A typed effective source identifies the original room or application grant;
application rules are never materialized as copied room grants.

Intake and question/permission actions re-resolve that source before the original
effect, including after a new group override. Application permission sharing
discloses limited original tool/request context to the application's affected
bound groups; only the effective authorized actor may decide the original request.
Changing a rule wakes only related existing publication lanes and never restarts
receivers or replays refused or unknown inputs. Known local access remains usable
when application access cannot be read; the observation gap stays explicit.

This package's binding owner authorizes boundaries only. Intake, external
publication and original Core question or permission execution remain separate
owners; creating or inspecting a binding performs none of those effects.

## Durable publication

The required integration target is the [Agent Conversation unified timeline and MECE contract](../../docs/specs/conversation-protocol.md#unified-timeline-and-mece). The conversation view and Feishu connector are consumers of the same Core timeline; connector-specific mapping and authorized sharing requirements belong to the [external conversation behavior contract](../../docs/design/behavior/conversation-mode.md#共同对话协议与外部交流入口). The current source reads and delivery mechanisms below do not certify complete compliance with that target.

`PublicationHost` borrows the original `ConnectionHost.database`, `RoomBindingReadPort` and exact Core conversation reads. `createPublicationConversationPort` adapts existing execution clients; it creates no Runtime, transcript reader or message queue. Desktop's original connection composition starts this owner and exposes its `ConnectionPort.delivery`. Configuration and Binding changes reconcile the same owner; source notifications wake durable catch-up rather than serving as the message log.

Each accepted page commits its necessary Outbox effects, explicit skips and source frontier together. Selection includes original assistant speech and typed questions, preserving separate records with equal text. Complete resource-backed text uses the original Core resource reader and verified content digest before exact Unicode fragmentation. The original assistant-only scope excludes process content; broad sharing consumes the original per-part purpose facts rather than presentation roles. Confirmed surplus platform fragments receive explicit withdrawal operations when a source revision shortens the speech.

Public PNG/JPEG/GIF/WebP parts readable through the existing Core resource API may also be represented in broad sharing. The Host validates the exact original resource response and retains its bytes, digest and dimensions in the same representation and Outbox. Text and image fragments keep their original part order; identical bytes in distinct parts retain distinct operations. Private, unconfirmed, unsupported or unreadable parts retain their original exclusion or gap, and independent text continues. File/audio/remote references are not image support. For deferred image parts stored as `resourceType: text` / `content.kind: resource`, the Host requests `representation: image` with the same outer signed reference. Core verifies the original complete part and decodes its raster internally; the Host does not unwrap or retry an inner reference. Default JSON fragment reads remain available. Separate finite envelope and decoded-image budgets apply, so the upload limit does not promise that every Provider image envelope is readable.

A low-level `PublicationAdapter` prepares a bounded request synchronously inside the claim transaction, after the original predecessor mapping is known. That transaction freezes the original request, render version, audience and platform key before dispatch. Credentials are resolved by the Host outside prepared data. Compatible retries consume that same frozen request; an unavailable render version retains the operation for inspection.

The adapter's `dispatch` and `inspect` calls also receive the original durable
platform mapping as a read-only final argument. It is absent for creation and
preserves the exact message and optional thread identity for updates and
withdrawals. The mapping is not encoded into credentials, request bodies or
request keys, and does not require an adapter-local record cache.

Every dispatch attempt has a private durable receipt correlation under the same operation and platform key. A late outcome updates its original attempt rather than certifying a later retry. An authoritative non-application permits an explicit same-ID retry; an unknown effect is inspected without replay, a new key or group-level fallback. Each Binding has an independent read/effect lane, so a slow or unknown effect does not occupy another Binding or the original Core input lane.

Within that lane, an unknown effect holds only its original projection and exact
mapping dependencies. Later independent messages can be prepared and dispatched
under their own current authority. Selection and atomic claim use the same
projection ordering and recheck the selected operation ID; another concurrent
claim cannot substitute an unqualified message. A failed image or file upload
does not prevent independent text in the same original message from being sent.
Audience-scoped open-operation indexes bound selection and read-only recovery to
the relevant retained work. Recovery uses one asynchronous inspection slot on the
existing lane and advances through original operation IDs. A slow inspection
cannot delay independent messages, an unchanged unknown result does not wake
itself, and a late receipt still settles only its original attempt. A newer
confirmed message cannot overwrite the audience's retained unknown observation.
The existing delivery and diagnosis RPC/CLI surfaces expose those aggregate and
per-operation facts; this scheduling change adds no public operation.

An image upload is a separate effect from its chat message. Each upload attempt and its result stay in the original operation JSON. A confirmed asset key is saved before the original claim freezes the final message request and key. Reopening after that save does not upload again. An interrupted upload or a reply without a key stays unknown; only explicit `connection.delivery.retry` may start another upload of the same bytes while the message is provably unattempted. Earlier unknown uploads remain recorded. A possibly applied message remains inspect-only, retaining its original key and wire. `ConnectionDelivery.resourceUpload` reports the exact part, upload attempt and stage without bytes or an asset key.

Mermaid fences in qualified public assistant text use the same ordered image
representation and upload owner. The Host renders with the official Mermaid
engine in a private headless browser, retaining the original text digest, source
span and derived PNG. It uses an installed Chrome, or the Host's explicit
`PUPPETEER_EXECUTABLE_PATH` for a compatible Chromium executable; dependencies do
not download a browser. This works independently of an open Desktop window and
does not attach to a person's browser profile. The private page cannot load
external or local resources, and diagram directives cannot relax its policy.

The engine's native source/edge limits and the existing Core raster decode
budget constrain only this derived image. A single render has a cancellable
30-second observation window, matching other Host resource observations; expiry
does not declare the original Agent or message failed. Missing browsers, invalid
diagrams and unconfirmed rendering leave a named gap, keep the original source
and deliver neighboring text. Source remains available in the original
conversation. Rendering adds no RPC, queue or credential store: existing
`connection.delivery.inspect`, `connection.delivery.ls` and content coverage
expose the original image upload, delivery and any unresolved resource gap.

Public `connection.delivery.inspect` and bounded `connection.delivery.ls` expose the original safe receipt and exact source reference, excluding body, prepared wire and credentials. The scoped list can report a source gap before any effect exists. Source replacement retains its old frontier for explicit relinking; storage or authority uncertainty retains the original work and reports the failed service step. Closing this publication owner releases only its readers and external-effect observation, preserving original Agents and durable operations.

## Durable external intake

`DurableIngressHost` borrows the original connection database, binding read port
and exact executing Host client. A Host registers an `IngressAuthenticator` for
each adapter. That private port verifies the original transport proof and issuer,
then supplies normalized actor, event, message, body and addressing facts. No
public caller can declare itself authenticated or turn a body header into an
external author. Platform adapters own verification; this package does not claim
that registering configuration has authenticated an event.

```ts
import { DurableIngressHost, ConnectionReceivers } from '@agentmux/connectors'

const ingress = new DurableIngressHost({ connections, bindings, authenticators, core: originalCoreForHost })
connections.ingress = ingress
const receivers = new ConnectionReceivers(connections, ingress)
// Close registered transports before closing their borrowed connection database.
receivers.close()
```

`receive` commits the complete raw event and normalized business facts before
calling the transport ACK. Event and message identities each include issuer
domain and App ID, so local aliases share application identities while unrelated
applications do not collide. Another verified transport attempt may carry new
metadata; the original complete event remains retained. A new event for the same
message reuses the original intake only for the same body, actor, conversation
and addressing facts. The same body in two distinct messages remains two inputs.
Authentication or storage failure does not ACK; a lost ACK is reconciled by the
same original event identity. Machine identity fields follow Core's existing per-field
protocol bound; that bound does not truncate the raw event or authored body.

`dispatch` authorizes the current exact binding and actor grant. Before any
possible Core input call, it saves a claim with the original Host, Session, Core
Run and stable operation/message IDs. Core receives structured external authorship
through its existing message envelope and input journal. The in-process Host
callback compares Core's actual frozen input with the original claim, then reads
current binding and grant revisions before possible admission or explicit rejoin.
Stored attribution is not a grant, and external actors are not local humans,
devices or Agent authors. Region position never routes this input.

A claimed intake means that a Core call may have happened. Further dispatch calls
and restart inspect that original operation; an absent receipt does not authorize
replay, retargeting or a new ID. `rejoin` is an explicit Host action only for a
positively saved original Core wait, using current authority. It does not replay
an unknown effect. Later independent platform messages can use the same Session's
current Run. Refusing one actor or conversation does not stop the original Agent
or remove ordinary local input.

The original message and input queues remain the only Agent delivery owners.
Intake records are transport facts, independent of connector publication Outbox,
user Pending, local read markers and native adoption. The original Desktop reader
shows the structured external actor and source without parsing the visible wrapper
for authority. The original public history retains that same attribution.

```sh
amux connection ingress ls --connection application-connection --limit 25
amux connection ingress inspect --ingress original-ingress
amux connection ingress authority --operation-id original-input-operation
```

These readonly methods use the actual connection owner. Listing is bounded to one
exact connection, with optional binding and original-intake continuation. A
binding-filtered continuation must come from that same binding and connection. Details
retain business body, actor, safe refusal code and original input references;
inspection reads the original Core receipt without dispatch. Raw payloads and
transport proofs remain private to the Host. An unavailable optional intake owner
limits these reads only; the original connection and Agents remain available.

Authenticated native actions use a separate `kind: 'action'` receipt in this same
ingress owner. Its original event ID identifies one action: two events on the
same source message remain two intakes, and exact redelivery returns the original
receipt. Conflicting content under one action event ID cannot replace the retained
payload. Action receipts and complete raw payloads commit together in the original
event row; existing message rows and their identities remain unchanged. Bounded
message/action pages share the original intake sequence and continuation.

Action receipts are explicitly `refused` with `INGRESS_ACTION_UNSUPPORTED`.
They retain available operator, external conversation, source message and opaque
action reference facts; absent facts stay absent. They contain no fabricated
message body, message author or input claim. Discovery and inspection use the
commands above, with `inputReceipt: null` and `observation: 'not-started'`.
Dispatch, rejoin and recovery cannot turn these receipts into Agent input, and an
action reference is neither authorization nor a question target. Ordinary local
Agent input remains available.

An authenticated parent reference is an original platform identity, not proof
that the message replies to this application. A registered adapter can qualify
that exact parent after the complete event is committed and acknowledged. The
bounded read runs before the original Core claim; a missing or failed lookup
keeps the same received body with a safe `addressing` observation. Its result
does not rewrite immutable event facts or redelivery identity. Current binding
and actor authority are checked again before input. A late lookup cannot claim
input after its observation timed out.

Unsupported authenticated content retains its complete private payload and a
durable `INGRESS_CONTENT_UNSUPPORTED` refusal before ACK. Its empty text
projection is never submitted to the Agent. This refusal limits this message
format only and leaves the original Agent and local input available.

## Registered receiving transports

A `ConnectionAdapter` can contribute an `ingress` authenticator and a `transport`.
`ConnectionIngressTransport.start` receives the original configuration, resolved
credential, an abort signal and `receive({ raw, transportProof? }, acknowledge)`.
It returns a receiver with `close()` and typed `observation()`. The proof is an
adapter-private in-process value. The callback freezes the connection identity;
an event cannot supply a different connection, Session or execution Host.

`ConnectionReceivers` starts only enabled configurations with registered ports.
The callback first verifies and commits intake, then ACKs durable retention. It
returns to the transport callback before a deferred turn enters original Core
input. Neither Core observation nor platform reply checks consume the transport
ACK budget. A revision change closes only that receiver and refuses its stale
callbacks. Current configuration is checked for each callback, so restoring the
same Host service does not require replacing an Agent or restarting the app.

Recovery reads bounded pages of the original database's unclaimed `received`
records, with a continuation per connection and a low frequency retry. A slow
page cannot starve later retained records. Claimed or unknown input is never
copied into a second queue or automatically submitted again. Transport service
facts overlay the original Connection observation, independently of publication.

Desktop composes this intake owner on its original shared database and borrows
the original Hosted execution transport through `createHostedIngressCorePort`.
Private authorization callbacks belong at that execution owner; ordinary Hosted
RPC arguments cannot carry them or authenticate external authors.

The product Node Host injects `AgentExternalInputAuthorityPort` into its existing
Headless Runtime. Its default local adapter reads `connection.ingress.authority`
from the protected original Desktop business endpoint. That pure database lookup
returns the original claim and current Binding/grant observation without reading
Core receipts, dispatching, or creating another lease or Store. The executing
adapter compares exact Host, Session, Run, operation, message, body and author with
Core's actual frozen intent before approving that operation. A `current` response
alone is not serialized permission. A remote embedding supplies its own original
authority port; a missing owner retains the original claim and limits only the
external action, without falling back to local manual input.

The integration fixture starts the actual Node Host and original Desktop
connection composition with a signed HTTP protocol and replay ledger. Native
connect and ordered byte I/O are controlled test ports; those leaves do not claim
a production webhook listener, live native CLI acknowledgement or platform delivery.

## Feishu low-level adapter

`FeishuAdapter`, imported from `@agentmux/connectors/adapters/feishu`, implements
the existing connection test and private ingress
verification ports using the pinned official `@larksuiteoapi/node-sdk` release.
It constructs `Client`, `WSClient` and `EventDispatcher` directly. The SDK's
high-level Channel, in-memory message deduplication, chat queues and response
policy are not used. The inspected low-level WebSocket handler awaits the event
handler before constructing its success ACK, and reports handler failure with a
failed ACK. [Official SDK](https://github.com/larksuite/node-sdk)

The generic connector entry and `createBuiltinConnectionAdapters()` do not load
this SDK. The built-in delegate loads one leaf instance when the original Host
tests or starts an enabled Feishu connection. A disabled connection or ordinary
connection list does not start platform I/O. Hosts can still select the adapter
subpath directly when composing their own trusted application.

A Feishu connection uses `adapterId: "feishu"` and a canonical application
**hostname**: `open.feishu.cn` or `open.larksuite.com`. The leaf constructs the
corresponding official HTTPS endpoint and accepts only a TLS WebSocket endpoint
returned by its authenticated discovery request. It does not accept a caller's
arbitrary domain alias, connection-host override or transport agent. Bot identity
comes from the authenticated `bot/v3/info` response, independently of receiving
or group delivery observations.

The adapter retains Core's original bounded App ID contract. A syntax guard in
one SDK release does not become a platform identity rule: receiver startup reads
the SDK's actual lifecycle result, while configuration and independently working
REST authentication remain available.

A trusted Host registers `FeishuAdapter` through its original `ingress` and
`transport` ports. The original receiver owner resolves credentials and calls
`transport.start({ config, credential, signal, receive })` with the exact
configuration and a guarded callback bound to that connection. The adapter
never chooses a second connection target or reads a second configuration owner.
The returned handle owns only that issuer/application receiver and provides
`observation()` and `close()`. The Host aborts or closes the old receiver when its
configuration changes. A second local receiver for the same issuer/application
fails explicitly, including through a different alias or adapter instance.
The registered ingress delegates both private proof verification and deferred
reply qualification to the same leaf instance.
`withClient` provides an exception-safe official Client call for other adapter
leaves without introducing an outbound queue or send policy. The exact connection,
application and credential reuse one official Client and its own SDK token cache;
credential or application rotation replaces that instance. Each call carries its
own request signal, independent of another caller or the receiver's lifetime.
The Client scope contains original connection and application identity alone;
publication does not invent configuration fields or treat cache reuse as authority.

The same lazy leaf contributes room creation and member invitation. Creation
uses the official `im.chat.create` method with private ordinary group defaults;
the native UUID is the original persistent random attempt ID, bounded by the
platform limit. The platform's finite UUID deduplication window does not
authorize retrying an unknown original operation. Bot membership follows the
native creation contract; requested members belong to a separate durable phase.
[Native creation contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/create)

Member invitation groups original IDs by their explicit native namespace,
serializing at most 50 users or 5 bots per request with `succeed_type: 1`.
Invalid and nonexistent IDs remain not-applied; approval-pending IDs remain
unknown. Malformed or failed observations retain earlier exact confirmations and
leave unconfirmed members unknown. Cancellation reaches the original SDK token
and effect requests and prevents later batches from starting. Neither leaf
replays creation or membership, searches by room name, creates a Binding or
restarts an Agent. The public original operation remains the recovery surface.
[Native membership contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/create)

The private dispatcher captures the complete original SDK callback object before
SDK flattening. Its JSON representation retains all header, event, extension,
message content and parent/thread fields. The SDK has already decoded the wire
JSON; this retained payload does not claim byte-for-byte wire whitespace or
repeated JSON keys. An asynchronous call-local witness binds that exact payload
to the original receiver, application and current configuration. Only witnesses
minted inside the private SDK callback are accepted by `verify`; copying a JSON
object, `authenticated: true`, an App ID or visible text cannot mint one. Witnesses
expire when that callback finishes and are never stored or returned over RPC.

For accepted human group messages, the SDK handler awaits `ingress.receive` and
its complete durable transaction before returning. A failed transaction propagates
a safe failure to the SDK, so a later delivery of that same event can still be
admitted. There is no adapter-local seen set. Scheduling original Core input is
a separate Host action after durable admission, preserving ACK time for storage.
Platform bot senders and direct chats are outside this human-group receiver's
scope; authored text never determines that distinction.

The same private SDK dispatcher also receives `card.action.trigger`. It awaits
complete durable retention before returning an empty callback response, which
acknowledges intake rather than answer completion. The adapter projects a native
operator `open_id` and exact context IDs only when present, and keeps every other
field in private raw. The Host records the generic unsupported action receipt
described above. Native card presentation does not establish question or
permission qualification; callback values, temporary update tokens and visible
labels cannot authorize an answer. This receiver does not publish interactive
controls or update cards through callback responses.
[Native card callback contract](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)

The text projection keeps the original text exactly and fixes actor identity to
the platform's `open_id` namespace. A mention qualifies only when the typed
mention ID equals the authenticated bot's original open ID. An arbitrary parent
or thread ID does not establish a reply to that bot. The original parent ID is
frozen with the authenticated event, without a network lookup before ACK.
Unsupported formats and unrecognized text encodings return an empty projection
with the explicit unsupported-content fact; the original intake owner durably
retains the complete payload and its safe refusal before ACK. No empty projection
is submitted as authored text.

`qualifyReply` reads the exact original parent through the authenticated SDK
Client after durable admission. Only a matching message ID, chat ID and the
application sender tuple (`sender_type: app`, `id_type: app_id`, original App ID)
qualify the reply. An explicitly different application or user author confirms a
regular message. Missing fields, duplicate parent records, deletion, wrong
targets and network failure stay unknown. Display names and `open_bot_id`
similarity do not certify the application principal.
[Original message read](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/get)

SDK token, bot, discovery and parent HTTP requests carry their original caller's
signal. Parent cancellation returns unknown without granting reply scope. A late
result cannot change that result or write intake facts; an already canceled
signal prevents a later parent HTTP request after token acquisition. The original
Host owns persistence, observation retry and final Core admission.

The leaf reports authentication, transport and durable-receiving observations
separately; none certifies delivery to a particular group. SDK log arguments are
contained because they can include credentials, short-lived connection tickets
and raw payloads. SDK exceptions are replaced with safe codes without retaining
an unsafe cause. These failures affect the connection operation only and do not
stop or replace the original Agent.

The SDK protocol samples and original Core/CLI/Mailbox consumer tests use
controlled network ports. They do not certify real application credentials,
platform subscription permissions, a live group, generic Host startup composition
or final platform end-to-end delivery.

## Feishu publication

The built-in Feishu delegate also exposes the original `PublicationAdapter`.
The original Desktop `PublicationHost` selects future native public speech,
commits its Outbox and calls this leaf automatically. Publication requires no
model send tool, duplicate queue or adapter-local message cache. Receiver,
parent reads and publication reuse the same official Client for the exact
connection, application and credential.

`feishu-post-group-v1` renders plain text nodes in a localized post. The original
text, including quotes, Unicode and apparent mention markup, remains text with
`un_escape: false`; the renderer creates no mention, card action or answer
control. Typed question prompts and option labels are informational text until
a separate authorized interaction owner supplies an exact action reference.
The current publication intent has no exact reply target, so this version uses
explicit group addressing and never infers which input caused a reply.
[Message content schema](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json.md)

A create request uses `chat_id` addressing and a stable SHA-256 operation key
encoded in 43 base64url characters. The official create contract permits a
UUID of up to 50 characters with a one-hour deduplication window. An unknown
create without a platform message ID has no supported UUID lookup: inspection
performs no request, and expiry never authorizes another create or a new key.
An authoritative non-application uses the original Host's explicit same-operation
retry. Rate limiting, missing targets and platform failure do not trigger a
thread-to-group fallback.
[Create message](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)

For recorded images the leaf uses the pinned official SDK `im.image.create` multipart API, then a post containing an image-only paragraph in its original fragment position. The effective byte budget is 10 MiB, bounded by the existing Core resource budget; GIF sides are limited to 2000 pixels and other accepted raster sides to 12000. Dimensions are verified by the original Core resource codec from the bytes. These header and size checks are not a full image decoder or a promise that the platform accepts every file. Missing upload keys never confirm success. Image message updates and withdrawals reuse the original message mapping, just as text does.

The Host fragments complete source text on Unicode boundaries with a conservative
4 KiB UTF-8 fragment budget. The leaf also checks the final, double-encoded HTTP
body against the platform's 30 KiB post limit, including target and envelope
fields. An oversized request is rejected during preparation before any platform
effect; the original pending operation and service diagnostic remain available.
Source text is never silently clipped. Axios receives the exact frozen request
body through `transformRequest`, preserving the durable bytes despite the SDK's
object-merging request implementation.

An update uses the original durable message ID with PUT. A withdrawal uses DELETE
for that same message. Both receive the original read-only mapping; an omitted
thread in a successful acknowledgement preserves its known original value.
Explicitly contradictory message, chat, application or thread facts remain
unknown rather than replacing the mapping. Read-only reconciliation fetches the
exact original message and checks its application sender, chat, thread and native
post content, or confirmed deletion. Missing fields and failed reads do not
invent successful effects.
[Update message](https://open.feishu.cn/document/server-docs/im-v1/message/update.md),
[Delete message](https://open.feishu.cn/document/server-docs/im-v1/message/delete.md),
[Read message](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)

Public `connection.delivery.ls` and `connection.delivery.inspect` retain each
source revision, fragment ordinal, operation and platform mapping through the
existing Host. Connection-wide Settings observations and a confirmed delivery to
one exact Binding have different scopes; one confirmed message cannot certify
other groups. An unknown external effect holds only its original projection and
mapping dependencies. Independent publication, subsequent authenticated inputs
and the original Core Session remain available.

The publication contract tests use the actual pinned SDK and Axios serialization
against a loopback HTTP server. The default Desktop Host tests consume original
SDK callbacks, Core history, Mailbox, Settings and compiled public CLI receipts.
These controlled ports prove the product call chain and exact bytes; they do not
certify live credentials, platform permissions or delivery to a real group.

## Discord native channel

Desktop Settings → Conversation Channels → Discord configures the built-in
`discord` adapter. Its immutable application is
`{ "domain": "discord.com", "appId": "APPLICATION_SNOWFLAKE" }`.
The Bot token is stored through the original secure Settings credential port;
public configuration retains only its `credentialRef`. Explicit connection checks
reread the native application and bot identity rather than certifying an earlier
cached check. No additional send RPC or CLI is introduced: configuration, service,
room discovery, Bindings, grants, delivery inspection and metadata management use
the original `amux connection` surface.

The official Gateway and REST SDKs own heartbeat, rate limits and reconnect.
Gateway intents cover guilds, guild/direct messages and Message Content; the
application must enable the corresponding native capability. Guild Members is
not requested for display profiles. Native channel permissions still govern
View Channel, Send Messages, Read Message History, Attach Files and sending in
threads. A visible channel or profile never establishes those permissions or an
AgentMux member grant.

Native channel IDs, including thread and direct-channel IDs, are exact external
conversation identities. The room catalog pages native guild text/announcement
channels; threads and direct channels remain exactly readable with `room.get`.
Guild members are not presented as channel members: without an exact native
membership result, `room.members` reports its observation gap. Explicit invitation
creation uses the original room-operation receipt owner and does not infer that a
person joined or received a grant.

Only the registered SDK receiver can mint ingress transport proof. Native authors,
mentions, parent references and application identity are separate from message
text. Own-bot messages and webhook/bot echoes do not become Agent input. The
existing durable ingress retains original events before advancing the saved
Gateway resume cursor; a custody failure closes only that SDK receiver and the
original receiver owner reopens it. Actor and channel observations reuse the
application-scoped Channel cache. Message/interaction authors, exact REST reads
and native channel/thread updates provide display metadata; cache refresh or clear
cannot alter recorded authors, Bindings or grants.

Messages use native Components V2 with automatic mentions disabled. Permission
buttons refer to the original permission action; question buttons open native
modals through the original read-only question-form owner. Native selections and
text submit typed answers to the existing durable action owner and original Core
responder. Each original question accepts one option or free text; an answer array
does not establish multiple-selection support. Answer and permission grants remain separate. Platform form capacities
retain an explicit limitation and exact local Agent entry when a native form
cannot represent the original request. Callback acknowledgements confirm durable
custody, not approval or native answer adoption. An unconfirmed callback keeps its
intake observation visible and does not close a healthy Gateway or remove local input.

The [SDK display-component contract](https://discordjs.guide/legacy/popular-topics/display-components)
bounds combined display text to 4000 characters and nested components to 40.
A longer public question or shared permission body uses a text attachment in the
same original multipart effect. Its short card names that complete original text,
retains the original action and exact Agent entry, and does not claim a shortened
body is complete. Only frozen public question text, recorded answers or shared
permission context and labels are derived into UTF-8 bytes. Transport state,
private credentials, action references and unavailable reasons do not enter that
attachment. Core's existing Hook projection supplies at most 8 KiB of serialized
tool context; this adapter does not reread raw private Hook payloads to bypass it.

Images and files use one native multipart message effect. The original Outbox
retains the bytes; a frozen request contains only generic resource descriptors
and native JSON. The current source read uses Core's fixed 16 MiB recorded-binary
budget; this is not a claim about a Discord account's native upload allowance.
Its effect context verifies the same operation's identity,
length and hash before the SDK reads bytes. Metadata cache cleanup cannot remove
pending or unknown effect data. No temporary message or fabricated upload key is
used. REST application retries are disabled. A stable bounded nonce and
`enforce_nonce` provide only the platform's short deduplication window, never
permanent delivery proof. A native response or authenticated own-message nonce
witness can confirm the original mapping. Unknown effects remain inspect-only;
text edits can inspect the exact retained message and authored native fields,
while attachment edits without a byte witness and unconfirmed deletions remain
unknown instead of being inferred from names or absence.

## Saved-application management confirmation

`ConnectionHost.setup` owns finite management-authentication intents in the original
Connection database. The [Core contract](../core/src/connection-setup-contract.ts)
and [strict codec](../core/src/connection-setup-codec.ts) expose the same result to
SDK and CLI consumers. Begin binds the original actor, operation ID, saved
Connection revision, application and goal before the native request.

```sh
amux connection setup begin --input management-request.json
amux connection setup advance --input original-action.json
amux connection setup inspect --operation-id management-confirmation
amux connection setup ls --connection saved-bot
```

`setup ls` also returns `support`, a local implementation declaration for the
current saved Connection revision. An existing bot has
`{ "connectionRevision": 1, "capabilities": ["management-authentication"] }`
when its registered adapter supports that application's domain; an unsupported
bot has an empty capability array, and an absent Connection has `support: null`.
This read does not load the native adapter, resolve private credentials or contact the
platform. Pausing a bot or automatic traffic preserves management discovery.
Support never confirms login, application authority, grants, publication or a
live connection. Clients match the revision before offering a new scan and keep
existing manual setup and original-result recovery available.

The begin input is:

```json
{
  "operationId": "management-confirmation",
  "connectionId": "saved-bot",
  "expectedConnectionRevision": 1,
  "goal": { "kind": "agent-conversation", "interaction": "messages" }
}
```

The native Feishu leaf issues one raw QR authentication challenge. Its payload,
flow key, cookies, console CSRF and account/enterprise identity remain private
through the original credential port and permission-protected SQLite owner. Safe durable records and list summaries contain
only request, authentication-stage and secure-handoff facts; local support is
reported separately. Begin and inspect
reveal active confirmation material only to the original transport-approved actor.
Present it only on that confirmation surface and redact ordinary logs. Inspect
and list perform local reads; a changed bot revision withholds the old challenge
and account while preserving the original request.

Without an initial-publication intent, a repeated begin with the same input reads
that original result or reconciles its original local secure handoff. Unknown native requests are not replayed. Paused
bots and disabled automatic traffic retain explicit management access. The
request ACK, secure handoff and active challenge remain separate facts.

Use `continuation.actions` to choose the next original action. Copy its exact
`actionId` **and its own `expectedRevision`**, including when recovering a lost
secure-store ACK. The advance input is:

```json
{
  "operationId": "management-confirmation",
  "expectedRevision": 4,
  "decision": { "actionId": "returned-original-action", "value": "continue" }
}
```

`continue` performs at most one claimed HTTP request, including one redirect hop.
Known waiting/scanned status permits a new observation action. Phone scanning,
login handoff and the exact account/enterprise confirmation are separate stages.
For an ordinary management request, a returned `confirm-account` action uses
`value: "confirm"`; that original confirmation marks this management session confirmed. It does not prove
saved-application management permission or tenant membership.

A repeated advance reads its original receipt or finishes only its original local
private-storage handoff. It never repeats the claimed native request, including after
an executing-owner process restart. Explicit `renew` abandons the current
authentication and requests a new challenge inside the same intent. The old init,
step receipts and original private snapshots remain retained; renewal never creates an
application. Private cookies are selected anew by a mature CookieJar for each
qualified HTTPS destination. The Console redirect chain admits the exact
`accounts.larkoffice.com` and `login.feishu.cn` HTTPS issuers in addition to the
original account, landing and Console hosts. Their scoped cookies and previous
hop remain available when the original private snapshot is reopened. These
issuers are transit sources only: account bootstrap is accepted only at
`https://open.feishu.cn` or `https://open.larkoffice.com`; the initial cross-login
entry hosts remain unchanged. The supported console encodings are direct literal
assignments and the observed anonymous, synchronous, zero-argument literal
initializer. Both are parsed without executing page JavaScript; arbitrary
programs, missing stable IDs, inert or conflicting responses stay unknown. The
public console response establishes the initializer syntax only: its empty user
object does not establish a logged-in account or enterprise.

Authentication alone is not live tenant qualification, configuration or publication.
The separate typed application inspection and finite configuration actions keep
their original receipts and current observations independent. A new ordinary application uses the separate Enrollment intent
below; confirming a management login does not authorize creation. Web creation
is offered only for adapter-declared domains. Existing saved and manual
connections remain usable independently.

### Automatic initial conversation setup

A new creation may explicitly authorize the complete initial setup in the same
`connection.setup.begin` input:

```json
{
  "operationId": "initial-management",
  "connectionId": "new-bot",
  "expectedConnectionRevision": 1,
  "goal": { "kind": "agent-conversation", "interaction": "cards" },
  "source": { "kind": "enrollment", "operationId": "original-enrollment", "expectedRevision": 5 },
  "initialPublication": { "version": "1.0.0", "notes": "Enable AMUX conversations." }
}
```

`initialPublication` requires the exact saved Enrollment source. The original
actor, creator, application and source revision qualify its local management
handoff. This explicit intent covers confirming that same saved creator,
enabling messaging, persistent event delivery, the minimal conversation
permissions and message reception; `cards` additionally covers independent
persistent callbacks and card actions. Each operation uses the current offered
read/action and the existing Setup child journal. Native entry choices remain
inside the adapter. There is no additional workflow or configuration store.

The Host then creates only the first version, visible to its original creator,
and submits that exact returned version ID. An existing independent version is
not selected or replaced. Source and write acknowledgements remain separate;
unknown writes stop at their original stage and are never replayed or rerouted.
The same complete begin input resumes the original intent. Explicit finite
`advance` actions retain their own semantics and receipts; after an account or
local-storage recovery, repeat the original begin to resume automatic work.

`initialSetup` in begin/inspect/advance is a local projection of those original
journals. It reports the exact stage and `pending`, `running`, `attention`,
`approval-required` or `complete`, with the exact version ID when known.
`inspect` remains read-only and performs no platform request. Repeating begin
may read the exact submitted version again; it never resubmits it. Platform
review remains visible. Completion requires an approved exact-version read and
does not claim a live receiver or successful message delivery. `setup ls`
reports local `initial-setup` support only for an adapter-declared original
Enrollment continuation and first-version draft capability.

## Original request evidence

Use `connection enrollment inspect --operation-id ID --request-trace` or
`connection setup inspect --operation-id ID --request-trace` for the same
actor-owned operation. SDK callers pass `requestTrace: { limit?, cursor? }` to
the existing inspect method. This selection returns `requestTrace` and the safe
operation summary, with no active challenge, account, continuation or write
choices. Setup trace selection is separate from its private inspection and
configuration selectors. Ordinary inspection omits `requestTrace`; omission
does not report an empty history.

The projection reads existing attempt, authentication, inspection and effect
journals in the original Connection database. Entries carry original step IDs,
stable sequence, finite action/subject/effect, request and secure-storage
receipts. Pages ascend through original attempt row IDs or Setup claim
revisions; `--trace-limit` bounds a page and `--trace-cursor` resumes that same
operation and actor. Appending a step does not shift older pages. Recovery
updates the original step rather than inventing a new request.

These are journal receipts, not an HTTP request log. `network: null` explicitly
means method, host, route, HTTP status and native code were not recorded here.
Enrollment `claimed` and `settled` report the original journal state; neither
certifies a live dispatcher or successful HTTP response. Original unknown
inspection/effect receipts retain that status. No account, Cookie, QR/token,
secret, query value, raw response or private path belongs in the trace.
Copy only the trace projection when sharing it for diagnosis.

Trace selection performs no platform requests, credential resolution,
checkpoint repair or write replay, including when the original operation is
unknown, private credential storage is unavailable or its adapter is absent after restart.
It is an independent local observation and cannot approve or repair creation,
permissions, publication, current application state or message delivery.

## Application enrollment

The original `connection.enrollment.begin/advance/inspect/ls` service owns one
explicit application-creation intent. Core supplies vendor-neutral contracts,
strict SDK/CLI parsing and public RPC dispatch. The default Host composes its
original SQLite journal, native adapter and secure credential owner. Enrollment
creates no Agent, group, Binding or sharing grant and does not publish an app or
prove a live connection.

`begin --input FILE|-` freezes `operationId`, `connectionId`, `adapterId`, `domain`,
`label` and `preset: {name, description?, avatar: {pngDataUrl}}`. The PNG uses the
original saved-avatar byte bound and strict PNG header/dimension validation;
the original secure owner retains its exact bytes while the safe summary stores
its hash and dimensions. Public CLI clients supply their own PNG. Desktop assets
and Mote source images are supplied through their original client/Host owners,
not a Core file path or a hosted image URL.

Begin, advance and inspect return an active View with a safe `operation`, private
`challenge` and `account`, and exact offered `actions`. The original
transport-approved user/device alone may read that View. `ls` returns safe
summaries and implemented capabilities; it contains no QR, account, cookie,
CSRF value or credential. Inspect and list are local reads, including while an
original native effect is in flight. Private-view reads recheck the original
transport and authentication attempt after secure-storage awaits; an obsolete
read cannot reveal an earlier QR or account.

Choose the exact offered action, including its `actionId` and `ownRevision`:

```json
{
  "operationId": "bot-creation",
  "ownRevision": 4,
  "decision": {
    "actionId": "returned-original-action",
    "kind": "confirm-account"
  }
}
```

Pass this input to `advance --input FILE|-`. An explicit `confirm-account`
confirms only the displayed stable account and enterprise. A separate offered
`create` decision authorizes a finite sequence: upload the frozen PNG, create
one ordinary application, read that exact application's credential, then save
the original credential/Connection result. Each HTTP has its own durable claim and
saved receipt before the next request. There is no template, capability switch,
event/callback, permission scope, visibility, version or publication operation.
Only `continue-authentication` may drive an offered login observation; it cannot
confirm an account or create an application.

An unknown request is not replayed. A repeated action reads its original decision
receipt or repairs its original local ACK. Intent rows retain only the active
decision reference; historical decision receipts are read by exact action ID,
separately from the original HTTP-attempt journal. The exact created app ID is
retained before credential handoff. If its credential read fails, a new explicit
`read-credential` can continue that same app; it never re-creates or selects an
application by name. Local credential/configure ACK recovery runs before current
adapter or login eligibility, including after owner process loss. A failed local
save cannot erase an already confirmed receipt or a different owner's recovery.

A finite typed `diagnostic` identifies the observed preparation, authentication,
request, response, adapter, journal or secure-storage stage. A response status is
included only when observed. No raw response, exception text or private material
is returned. Diagnostics do not authorize replay or invent a cause for an older
unknown operation. Authorization, secure credential storage, configured
Connection and live reception remain separate facts.

The obsolete device-registration execution is removed. Existing durable
operations keep their original IDs, stored bytes and unknown meaning. Reads
safely project those original facts; recovery may inspect and finish their
original local secure/configuration ACK. Missing Web account state never mints a
new native action or silently changes the creation route. No migration or new
compatibility executor is introduced. A separate new setup requires a separate
explicit intent. Existing credential-entry and saved-connection management
remain available independently of Enrollment observations or automatic traffic.

## Application profile operations

Bot profile writes use the original `connection setup` management owner. Begin
with an explicit `profile-update` goal containing at least one desired name,
description or saved PNG, plus publication notes. The original account must sign
in and be confirmed for the exact application. No application is created and no
bot credential is substituted for management authorization.

The original Setup journal freezes private input and publishes only safe desired
text and image hash. Its finite flow reads the current complete application and
published audience, uploads the original image when requested, writes complete
base information, reads back the result, and creates/submits its original version.
Name updates apply to configured locales; a single description changes only the
reliable primary locale, preserving other translations and unrelated fields.
The PNG upload uses its real dimensions. Publishing keeps the complete current
included and excluded audience. Other pending changes require explicit review;
profile intent alone cannot publish unrelated application changes.

`profileUpdate` exposes the current finite stage and original offered actions.
Use the same `connection setup inspect/advance` and exact operation identity;
inspection and request-trace reads are local. Unknown effects are not sent again,
including through a new account or alias. Secure receipt recovery does not
repeat a platform request. No alternate write route or compatibility executor
remains.

The Connection owner retains `connection profile get/inspect/ls`. `get` uses the
official SDK only for explicit current online observations. The native bot name
and avatar, application metadata, exact online-version description and version
status remain separate facts; an image URL does not certify PNG equality.
`inspect` and bounded `ls` read historical profile receipts without platform
requests. Historical missing diagnostics remain absent, and old unknown writes
never become Console requests. Retired `sync` and `advance` write methods are
not advertised or executed. Existing messaging and Agent work remain available.


### Saved Mote profile operations

Desktop composes `space.mote.connection.create/sync/advance/inspect/ls` over
its original Files, saved-avatar and Connection owners. Core supplies the pure
contract and strict SDK/CLI parsing; connectors do not acquire a Mote or file
configuration store. Each request freezes the exact saved public topic revision,
optional saved PNG appearance revision, default-file baseline and child IDs
before enrollment. Only the saved public title/summary and selected saved PNG
are shared. Personality, private memory, unsaved editor content and avatar
creation are outside this operation.

New enrollment freezes the selected saved PNG and exact public title/summary
as its first creation input. General identities use AMUX's own icon and public
description. Creation does not repeat those fields through a profile upload or
PATCH. Its actor-private login View remains owned by Enrollment;
Mote list/inspect receipts contain safe child summaries. A parent `advance`
without an `enrollment` decision only observes that child. To confirm an account
or create, pass the exact child operation ID, offered action and own revision in
`enrollment`; the parent never invents or automatically chooses either decision.
An explicit `initialPublication` in the create input also authorizes conversation
configuration and creator-only first publication, using Enrollment's fixed Setup
identity. Settings includes that scope in the creation confirmation. Configuration
finishes before creating and submitting that first version; genuine platform
approval remains a separate result. The offered `continue-setup` action continues
that same Setup, while inspect/list/recover-local remain local reads.
Parents without that intent retain their original creation-only scope and saved
child facts. An explicit Mote profile sync freezes a separate `profile-update` Setup child.
Its confirmed management account drives the Console update and intended
publication; additional pending changes require review. The parent exposes the
fixed `setupOperationId` and safe Setup summary. An explicit offered Setup
decision is carried in the parent `advance` input’s `setup` field. Historical
Profile children remain read-only and are not reinterpreted as new Setup tasks.

Default preference saving remains an original Files CAS. The parent records the
full save input and dispatch claim before calling it. A lost File acknowledgement
or process exit leaves that same save unknown; current equal values cannot
certify its ACK or permit an automatic rewrite. Explicit reassociation uses a new
original preference-save intent with the same already-created application.
`sync` changes neither the Mote default nor any existing group Binding.
`inspect/ls` read only the original parent journal; explicit `advance` can inspect
or explicitly advance the fixed children, without replaying unknown creation, upload,
profile or File writes. Independent Motes and original connections remain usable.

The original Mote Profile exposes these parent operations from its bot row.
The preview reads `topic.md` and the saved avatar through their original public
owners; display summaries and editor drafts are not write sources. Creating a
bot, changing the default choice and synchronizing an existing application's
public profile are explicit, separate actions. Synchronization can affect other
Motes and groups that use the same application.

Before dispatch, the Workbench retains each complete original create or sync
input under its operation ID. This is a client request, not another operation
journal. A lost Renderer reply can be recovered from the same Mote's parent
list or inspect route; a missing lookup never proves that nothing happened.
Known unsent requests can be explicitly continued after local storage recovers.
An independent new setup is separately named and keeps all previous requests.

Settings remains the application identity library. Each exact application has
a bounded public-profile observation and original-update view. Reading current
profile data, inspecting a saved operation and explicitly advancing it retain
their different meanings. These profile views do not submit a publication or
treat a current profile/default value as an acknowledgement of an earlier unknown write.
Browser clients consume `@agentmux/core/mote-connections`, the pure existing
parent contract and codec leaf, without loading the Node Runtime.


## Channel display metadata

The original ConnectionHost owns one durable Channel storage mechanism, isolated by adapter,
native domain and application ID. Adapters own display metadata keys, native schemas and freshness;
this is separate from the application's bot profile and from immutable message attribution.

Use the public `connection metadata get --input FILE|-` and bounded `ls --connection ID --kind
actor|conversation [--limit N] [--cursor CURSOR]` to read this local owner. Get accepts `connectionId`
and `subject`: `{kind:"actor",actor:{application:{domain,appId},idType,userId}}` or
`{kind:"conversation",externalConversationId}`. Reads never request native data and remain available
when the same Connection is disabled or its unrelated configuration changes. A deleted Connection
is not recreated to read its former cache. Entries preserve exact subject, state, prior confirmed
name/avatar, freshness, latest failure reason and cacheRevision; they are never input or grant proof.

`refresh --input FILE|-` additionally requires current `expectedConnectionRevision` and performs an
explicit exact native lookup. `clear` requires the same scope and `expectedCacheRevision` from
get/list (or null for absent cache). Clear only addresses that adapter's derived metadata key, not
messages, grants, Sessions, unknown native operations or bytes retained for those effects. No public
operation exposes arbitrary storage keys or values. Managed Agents retain the original enrollment
Connection boundary; metadata does not expand application administration authority.

The default Feishu adapter observes exact human contact and chat SDK resources after durable intake
ACK. Original `im.chat.updated_v1` events refresh only their exact group through the same owner;
the receiver does not change platform subscriptions or permissions. A native read failure retains
confirmed metadata as stale and can recover on subsequent relevant intake or explicit refresh.
`ConnectionServices.onChannelMetadataChanged` carries the exact changed subject for local
clients to reread the same owner; it does not rewrite a previously frozen input profile or an author.
Missing cache, credentials or display observations cannot block native ACK, authenticated input,
publication or another healthy Agent. Controlled SDK consumer tests do not qualify a live app's
subscription, data visibility or permissions.
