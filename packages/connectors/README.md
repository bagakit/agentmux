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

This owner does not bind conversations, receive external messages, publish Agent
output, answer questions or operate permissions. Those capabilities consume their
original Core identities and their own connector delivery records. Connection
storage failure remains local to the connection service and does not stop healthy
Agents or replace their Sessions.
