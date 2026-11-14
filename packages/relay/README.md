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
