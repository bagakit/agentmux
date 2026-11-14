# AgentMux Relay

`@agentmux/relay` provides encrypted connections and the V2 forwarding protocol.
It has no Core, Agent, Session, Desktop or UI dependency. A Core service can embed
the gateway; a small independent process can use the same package at an edge.

The gateway admits publisher routes and forwards opaque encrypted bytes. The
original endpoint authenticates clients, authorizes each RPC and owns its
resources, Sessions and recovery. A gateway credential does not grant access to
those resources.

## Embed a gateway

```ts
import { attachRelayGateway } from '@agentmux/relay/gateway'

const gateway = attachRelayGateway(originalHttpServer, {
  publishers: [{ serverId: originalServerId, tokenHash: savedPublisherTokenHash }],
})

// Stops Relay connections only. The original HTTP(S) server remains owned by its host.
await gateway.stop()
```

The gateway uses `/ws`. Other HTTP and WebSocket paths remain with the original
server. Its host supplies TLS, startup and shutdown. Two active publishers with
the same route are refused rather than displacing the original connection.

## Run a lightweight forwarding process

```sh
agentmux-relay secret
```

This explicit provisioning command prints a new `token` and its `tokenHash`.
Keep the token private on its publisher. Put only the hash into the gateway's
private configuration file:

```json
{
  "host": "127.0.0.1",
  "port": 8444,
  "publishers": [
    { "serverId": "original-server-id", "tokenHash": "<SHA-256 hash from secret>" }
  ]
}
```

```sh
agentmux-relay serve --config /absolute/path/relay.json
```

Configuration is read once at startup. The default bind address is loopback;
deploy a TLS endpoint or HTTPS reverse proxy in front of this listener for remote
publishers. Forward `/ws` with WebSocket upgrades. The readiness line and
`GET /healthz` identify the listener and protocol without exposing credentials or
the publisher list. `SIGINT` and `SIGTERM` close this process's Relay connections.

The same standalone composition is available as
`startRelayGateway({host, port, publishers})`. It returns the actual bound address,
`connectionInfo(serverId, connectionId)` and `stop()`.

## Publish an original endpoint

The existing `startRelayTransport` in `@agentmux/relay/server` initiates both the
control and data connections to the gateway. Supply the route's private token
in the WebSocket `Authorization: Bearer ...` header, never in the URL or logs.
The original daemon key and E2EE client authorization remain at the endpoint.

Gateway interruption ends transport readers. The endpoint retains original
Sessions and unresolved operations; transport reconnection does not replay an
RPC, prompt or process start. A failed publisher affects its own route, while
other publisher routes retain independent forwarding and backpressure.

## Embed in an AgentMux Core

A separate forwarding process is optional. The original Core can own the same
package attachment directly:

```ts
import { startHeadlessAgentMux } from '@agentmux/core/headless-runtime'

const core = await startHeadlessAgentMux({
  relayGateway: { configurationPath: '/absolute/path/core-gateway.json' },
})
// Existing owner shutdown releases its gateway, not the Native Runs.
```

For a dedicated gateway listener, `core-gateway.json` contains:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8444 },
  "publishers": [
    { "serverId": "<original Host's device.ls hostId>", "tokenHash": "<publisher token SHA-256>" }
  ]
}
```

```sh
agentmux-runtime serve --gateway-config /absolute/path/core-gateway.json
amux --endpoint unix:/original/core.sock system relay inspect
```

Use the actual `socketPath` returned by `serve`; `/original/core.sock` and
`/original/host.sock` below are placeholders for original owner sockets.

A dedicated listener exposes only Relay transport. It does not expose anonymous
Core HTTP RPC. Use a TLS reverse proxy for remote access, or set
`listen.tls: {"key":"<PEM private key>","cert":"<PEM certificate>"}` in the
private file. Omitting `listen` borrows an explicitly configured Core HTTP(S)
listener; its original HTTP authorization remains in force. A missing shared
listener, invalid config or bind failure reports `unavailable` while the original
Unix Core remains usable. Inspection is passive: `listening` confirms the
listener, not a publisher connection, device approval or completed RPC.

## Connect an original AgentMux Host outbound

This first delivery provides explicit Core/CLI access. On the accessing machine,
prepare its original RPC client key:

```sh
agentmux-runtime relay-key
```

Only its public key is printed. The default private identity is reused at
`~/.agentmux/relay-client-keypair.json`; preserve it across reconnects. An explicit
`--file /absolute/path/key.json` provisions that exact file; a custom SDK client
must use that same key pair. The CLI's default RPC key does not change with
`--file`.

On the original Host, read `amux device ls` through its authenticated local Unix
endpoint for the exact `hostId`. Admit that route and its private publisher token
hash at the gateway. Supply the token and accessing client's public key in the
Host's private outbound configuration:

```json
{
  "relay": { "endpoint": "gateway.example:443", "useTls": true },
  "publisherToken": "<private token from agentmux-relay secret>",
  "allowedClientKeys": ["<publicKeyB64 from the accessing machine>"]
}
```

The Host's startup option is `outboundRelayConfigurationPath`; its process entry
reads `AGENTMUX_OUTBOUND_RELAY_CONFIGURATION_PATH`. The same entry accepts
`AGENTMUX_RELAY_GATEWAY_CONFIGURATION_PATH` to embed the gateway in that Host's
original Core. Each configuration is read once. Adopting a changed file requires
an intentional owner restart with its original namespace, Store, device
credentials and Native state; editing the file is not a save/adoption receipt.
No inbound listener on the publishing Host is required for this outbound path.

Read its connection link through the original local endpoint, then use the
complete returned `url` from the admitted accessing machine:

```sh
amux --endpoint unix:/original/host.sock device link --via gateway
amux --endpoint '<complete returned URL, including fragment>' device hello --name 'My CLI'
amux --endpoint '<complete returned URL, including fragment>' agent ls
```

The returned gateway offer is an RPC/CLI link. It does not promise a Mobile page
or create a saved Desktop Host/Launcher entry. Default `device link` still reads
the independent local mobile carrier. The gateway publisher token admits a
route; the original Host's client-key pins admit encrypted devices; the original
Core still authorizes each operation. `device revoke` disables an exact original
device even if its key remains pinned. Device listing and revocation require the
original Host's local Unix user; `device hello` names only its authenticated
encrypted device and can use the gateway. An empty pin list admits no clients.
Invalid optional outbound configuration leaves local Core and existing Agent
work available. Carrier `connected` is a transport observation, not a grant or an
Agent readiness check.

These are package/source usage contracts, not a CN1 deployment, another Mac's
installation, npm publication or GUI inventory integration receipt.

## Design references

The composition borrows outbound attachment and local ownership from
[NATS leaf nodes](https://docs.nats.io/learn/topologies/leaf-nodes), explicit
transport admission from [libp2p Circuit Relay v2](https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md),
and the distinction between coordination and forwarded data from
[Tailscale's control/data planes](https://tailscale.com/docs/concepts/control-data-planes).
It uses the existing Relay protocol and dependencies; it adds no NATS bus, VPN,
recursive routing or global discovery service.

### Authenticated multi-gateway network

A gateway can also join an explicitly configured Relay Mesh. Peer links propagate origin-signed topology and publisher advertisements; a V2 client can enter one gateway and reach its original publisher through several others. The gateways carry the existing E2EE handshake/ciphertext. They neither decode Core RPC nor acquire the original device, Runtime, Session or `adoptedRoute` authority.

`createRelayGateway({ publishers, mesh })` creates the same volatile router/network owner used by `attachRelayGateway` and `startRelayGateway`. It does not require a listener. `attach(existingHttpServer)` lends an HTTP upgrade surface and returns `detach()`; detaching stops new upgrades while already accepted healthy streams continue. `configure(next)` reconciles peers and admission without recreating unchanged channels. `inspectMesh()` is passive, `resolvePublisher(serverId)` returns the current network route advertisement, and `stop()` releases only the owner's network resources. The caller retains HTTP/TLS lifetime. Core/Host may attach a private loopback publisher surface to this same owner while all remote peer connections remain outbound.

The runtime Mesh configuration has this shape:

```ts
import {
  createRelayGateway,
  type RelayMeshConfiguration,
} from '@agentmux/relay/gateway'

// The containing owner reserves this identity's monotonically increasing epoch
// durably before activation. It is not a timestamp or the original daemon key.
const mesh: RelayMeshConfiguration = {
  networkId: 'my-network',
  identity: reservedPrivateNetworkIdentity,
  members: explicitlyAcceptedPublicPeerDescriptors,
  peers: [{ peerId: acceptedNeighborId, endpoints: [
    { endpoint: 'gateway.example:443', useTls: true },
  ] }],
  advertisedIngress: [{ endpoint: 'this-gateway.example:443', useTls: true }],
}
const gateway = createRelayGateway({ publishers: originalPublisherGrants, mesh })
const attachment = gateway.attach(existingHttpServer)
// await gateway.configure(nextConfiguration)
// attachment.detach()                  // keeps existing channels and HTTP host
// await gateway.stop()                 // closes this owner's channels only
```

`createRelayMeshIdentity()` generates a private Ed25519 network key and public descriptor; `relayMeshPeerId(publicKey)` is the public-key fingerprint. The runtime accepts `{ peerId, publicKey, secretKey, epoch }`, with canonical base64 keys. This key is separate from a publisher's E2EE daemon key and all Core/Device/route-signing identities. The containing Core owns persistence, reserved epochs and operator configuration. The Relay runtime writes no Core or Agent state. Public configuration/observation parsers and the shared `RelayMeshConfiguration`, `RelayMeshObservation`, `RelayMeshRoute` types are exported from `./gateway`.

Every member's public key is explicitly pinned. A direct adjacency additionally requires both peers to list each other and complete a fresh two-sided signed challenge. A member list grants network participation only. Private dialing endpoints are separate from `advertisedIngress`, which is an explicitly authored client-facing V2 entry. Binding a listener, authenticating a peer or constructing an offer does not certify an external client's reachability or a business operation's success.

The network keeps the latest signed `(epoch, revision)` record per origin and forwards accepted changes through real peer links. New paths use reciprocal connections with matching generations, then hop count, stable RTT classes and deterministic peer IDs. A simple path cannot exceed the explicit member set; there is no arbitrary total lifetime or cumulative-byte limit. Each circuit freezes its target/publisher generation, full path and per-edge connection/boot generations under its ingress peer's signature. The new circuit is checked again after asynchronous data establishment. Topology improvements affect future circuits. A failed or explicitly revoked circuit is closed independently; encrypted payload or an unknown original RPC is never replayed onto another path.

Control records have a 1 MiB individual frame budget and a 2 MiB pending control-writer budget. Data retains the original RPC/E2EE frame budget and shared high/low-water flow control. Pending and active circuit admission is bounded per actual local adjacent peer; unrelated remote path members are not charged as local socket owners. A slow data reader has its own socket and does not block control propagation or another publisher. These are in-flight resource bounds, not limits on cumulative conversation length.

Remote peer transport should use WSS. A reverse proxy must forward WebSocket upgrades for `/mesh`, `/mesh/data` and the original `/ws`, including authorization headers. Data sockets are opened in the same TCP direction as the already authenticated control's dialer, and carry bytes in both directions; outbound-only participants need no reverse TCP ingress. Plain WS is an explicit private-network/loopback choice. `/healthz` exposes only safe listener/network counts, never credentials, circuit capabilities or payloads.

### Standalone private network identity and recovery

The independent executable uses an explicit private state directory and the same runtime. Initialize each peer at a **new** absolute state path:

```sh
agentmux-relay identity --state /absolute/new-private-mesh-state
```

The command prints only `peerId`, `publicKey` and its reserved epoch. Exchange the public descriptors through your own authorized configuration process. The private `identity.json` remains in the selected directory. A standalone configuration adds `meshStateDirectory` and a `mesh` object containing `networkId`, `members`, `peers` and optional `advertisedIngress`; omit `mesh.identity`, which the standalone state owner supplies. `host`, `port` and `publishers` retain the original gateway configuration. Start it with:

```sh
agentmux-relay serve --config /absolute/private-gateway.json
```

The standalone assembly requires macOS `lockf` or Linux `flock` for one nonblocking OS advisory owner. Missing locking capability makes this activation unavailable. Every init/serve/reconcile uses the same persistent `owner.guard` inode; it is never renamed or removed. The guard child is bound to its parent's stdin lifetime. Unexpected guard loss stops this assembly's network; a healthy other Core/Native/Agent is outside its ownership. A competing process cannot wait indefinitely, terminate or replace an incumbent.

A durable epoch is acknowledged only after atomic file replacement and fsync of the file, state directory and every newly created ancestor entry. Existing private keys are never replaced after a corrupt/missing observation. A crash or lost durability acknowledgement retains the exact `owner.lock`, operation and key; it is not a reason to guess lock expiry from PID or wall time. Inspect and explicitly reconcile the original receipt:

```sh
agentmux-relay state inspect --state /absolute/private-mesh-state > /absolute/observed-mesh-state.json
agentmux-relay state reconcile --state /absolute/private-mesh-state --expected /absolute/observed-mesh-state.json
```

Inspection is read-only and prints public state plus original owner/operation selectors. Reconcile is **offline recovery on the original local Host**: it must obtain the same OS guard, compare the complete original owner/intent/key/epoch receipt, and confirm that the original Node metadata writer no longer exists. Guard-child exit alone is insufficient: a live, reused, inaccessible or otherwise unconfirmed writer PID refuses recovery. An absent owner or incomplete intent also preserves unknown state and does not clear a marker. Only after these checks and durable readback may it release the exact retained marker. It never kills a process, mints a key, increments an epoch, repeats the original save or reconstructs a lost original acknowledgement. It reports readback confirmation separately. A stale inspection, unconfirmed identity or failed readback refuses only this recovery attempt and preserves the original material. A later explicit `serve` reserves the next epoch with the same key. Keep this private state on its original local filesystem; do not manually remove `owner.guard` or share a private network key between active assemblies.

This source/private-network capability is not a production deployment, public relay service, remote-Mac installation, Desktop enrollment or npm publication.
