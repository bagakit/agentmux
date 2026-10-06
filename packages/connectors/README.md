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
