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
