# Node Host startup context

The compiled `dist/index.js` owns Core independently of its public clients. Its
trusted launcher supplies the original absolute `AGENTMUX_AGENT_SESSION_STORE`.
An optional `--store` must identify that same file. The public Unix endpoint is
`control.sock` in `AGENTMUX_RUNTIME_DIRECTORY`.

To host connectors in this process, additionally pass the original absolute
`AGENTMUX_CONNECTOR_DIRECTORY`. The Host opens the connection database and
private credential owner there; it does not infer this directory from the
Session Store, cwd, or execution Host. Optional
`AGENTMUX_MOTE_CONFIGURATION_PATH` identifies the original absolute AppConfig
file for Mote resources and saved Executor settings. It is read on demand,
without a configuration mirror or another Executor registry.

For a fresh namespace, after building the workspace packages:

```sh
AGENTMUX_AGENT_SESSION_STORE=/absolute/original/state/sessions.json \
AGENTMUX_RUNTIME_DIRECTORY=/absolute/original/runtime \
AGENTMUX_CONNECTOR_DIRECTORY=/absolute/original/connections \
node apps/host/dist/index.js --store /absolute/original/state/sessions.json
```

Manage it through the existing public SDK or CLI:

```sh
amux --endpoint unix:/absolute/original/runtime/control.sock connection credential store \
  --operation-id original-credential --secret-stdin
amux --endpoint unix:/absolute/original/runtime/control.sock connection ls
```

Credential bytes belong on protected stdin or the protected Unix SDK call,
never command arguments or logs. The existing runtime fence and person/device
authorization apply. Configuration, metadata, bindings, grants, ingress and
delivery retain their existing methods and receipts. No RPC or CLI is added.

Without either connector context variable, the entry retains bare Core behavior.
A missing or relative connector directory exposes the original local storage
error and can be retried on that owner; it does not write under cwd, select
another owner, or prevent Core and healthy Agents from starting. An unavailable
Mote configuration refuses the corresponding Mote operation while ordinary
channel services remain usable.

This explicit Node startup support does not switch Desktop's default connector
owner, move old credentials or bindings, activate live connections, or qualify
a remote deployment. The connector hosting Host remains distinct from a
binding's execution Host. Client disconnect releases its reader, without stopping
the Host or Agent Runs. Restart the Host with the same original namespace to
retain identities and operation receipts.
