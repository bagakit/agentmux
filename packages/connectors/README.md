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

`SecretPort.resolve` returns a credential only to the executing adapter. A
headless embedding must supply its own secure resolver. Public configuration,
operation results and diagnostics contain only an opaque `credentialRef`.
Adapter exceptions are reduced to safe stage reasons because raw platform errors
can contain credentials. Desktop uses the operating system encryption service and
stores only encrypted credential bytes. Unavailable encryption, including a
plaintext storage backend, does not write a credential.

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
registry and the original Core spatial read port. Attach it as `connections.rooms`;
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
It then rechecks the original spatial revision and exact Region occupant before a
synchronous transaction saves the immutable binding, current mapping and applied
operation together. No SQL transaction spans an await, and no cross-database
atomicity with Core is claimed. A `preparing` receipt confirms intent only. After
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
prior revisions, and a later Binding revision does not inherit old actor grants.

This package's binding owner authorizes boundaries only. Intake, external
publication and original Core question or permission execution remain separate
owners; creating or inspecting a binding performs none of those effects.

## Durable publication

`PublicationHost` borrows the original `ConnectionHost.database`, `RoomBindingReadPort` and exact Core conversation reads. `createPublicationConversationPort` adapts existing execution clients; it creates no Runtime, transcript reader or message queue. Desktop's original connection composition starts this owner and exposes its `ConnectionPort.delivery`. Configuration and Binding changes reconcile the same owner; source notifications wake durable catch-up rather than serving as the message log.

Each accepted page commits its necessary Outbox effects, explicit skips and source frontier together. Selection includes original assistant speech and typed questions, preserving separate records with equal text. Complete resource-backed text uses the original Core resource reader and verified content digest before exact Unicode fragmentation. Reasoning, tool data and internal metadata are excluded. Confirmed surplus platform fragments receive explicit withdrawal operations when a source revision shortens the speech.

A low-level `PublicationAdapter` prepares a bounded request synchronously inside the claim transaction, after the original predecessor mapping is known. That transaction freezes the original request, render version, audience and platform key before dispatch. Credentials are resolved by the Host outside prepared data. Compatible retries consume that same frozen request; an unavailable render version retains the operation for inspection.

The adapter's `dispatch` and `inspect` calls also receive the original durable
platform mapping as a read-only final argument. It is absent for creation and
preserves the exact message and optional thread identity for updates and
withdrawals. The mapping is not encoded into credentials, request bodies or
request keys, and does not require an adapter-local record cache.

Every dispatch attempt has a private durable receipt correlation under the same operation and platform key. A late outcome updates its original attempt rather than certifying a later retry. An authoritative non-application permits an explicit same-ID retry; an unknown effect is inspected without replay, a new key or group-level fallback. Each Binding has an independent read/effect lane, so a slow or unknown effect does not occupy another Binding or the original Core input lane.

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
other groups. An unknown external effect blocks only its original publication
lane. Subsequent authenticated inputs and the original Core Session remain
available.

The publication contract tests use the actual pinned SDK and Axios serialization
against a loopback HTTP server. The default Desktop Host tests consume original
SDK callbacks, Core history, Mailbox, Settings and compiled public CLI receipts.
These controlled ports prove the product call chain and exact bytes; they do not
certify live credentials, platform permissions or delivery to a real group.
