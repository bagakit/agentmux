# AgentMux Node Host

`@agentmux/host` is the long-lived Node process that owns Core on a machine, independently of any client window. Desktop bundles it and starts it through its macOS Host service; it can also run on its own. One Host process provides:

- the public Unix endpoint (`control.sock`) that the `amux` CLI, Desktop and SDK clients call;
- the phone web page and an end-to-end encrypted LAN Relay for [AgentMux Mobile](../mobile/README.md);
- background automation that must keep running without a window: Goals, Supervisor delegations, schedules and continuous progress;
- the default connector owner for Feishu/Lark and Discord ([`@agentmux/connectors`](../../packages/connectors/README.md));
- Mote presence and dialogue, Capsule page hosting adapters, and an optional Tailcat listener.

Clients only own their connections. Closing Desktop or disconnecting a phone releases that client's readers; the Host and the Agent Runs keep going.

## Starting the Host

The compiled entry is `apps/host/dist/index.js` (`pnpm --filter @agentmux/host build`). The trusted launcher passes the namespace through environment variables; the Host never infers one from the cwd or from another path.

| Variable | Required | What it enables |
| --- | --- | --- |
| `AGENTMUX_AGENT_SESSION_STORE` | Yes | Absolute path of the Agent Session Store. An optional `--store` argument must name the same file. The device identity, Relay key pair and other Host state are kept next to it. |
| `AGENTMUX_RUNTIME_DIRECTORY` | No | Directory of the public endpoint `control.sock`; defaults to Core's runtime directory |
| `AGENTMUX_HOST_CONFIGURATION_PATH` | No | Absolute path of the client AppConfig file. Enables Goals, schedules and continuous progress, Mote presence, spatial Agent control, the Tailcat listener and, when the connector directory or Mote configuration is also set, the remote Hosts saved in that file. If unset, `AGENTMUX_MOTE_CONFIGURATION_PATH` serves the same purpose. |
| `AGENTMUX_CONNECTOR_DIRECTORY` | No | Absolute directory for the connection database and credential owner. Without it (and without the Mote configuration), the Host hosts no connectors. |
| `AGENTMUX_MOTE_CONFIGURATION_PATH` | No | The AppConfig file read for Mote resources and saved Executor settings when serving connector and Mote operations; read on demand, with no copy or second Executor registry |
| `AGENTMUX_MOBILE_BUILD_DIRECTORY` | No | Built phone web page; defaults to `apps/mobile/dist` next to the Host build |

For a fresh namespace, after building the workspace packages:

```sh
AGENTMUX_AGENT_SESSION_STORE=/abs/state/sessions.json \
AGENTMUX_RUNTIME_DIRECTORY=/abs/runtime \
AGENTMUX_HOST_CONFIGURATION_PATH=/abs/config/config.json \
AGENTMUX_CONNECTOR_DIRECTORY=/abs/connections \
node apps/host/dist/index.js --store /abs/state/sessions.json
```

The Host reserves the public endpoint before it loads any Core owner, so a second Host never displaces or adopts a live one. Before running an Agent, it loads the user's login-shell environment once; an incomplete load is retried by the next execution rather than replacing the Host or any Session. When startup finishes, it prints one JSON line with `protocol`, `pid`, the Runtime `owner` identity and the current `mobileAccess` state. `SIGTERM` and `SIGINT` close every Host resource once; Agent Runs are retained.

Restart the Host with the same namespace to keep identities and operation receipts. Optional parts fail on their own: a missing or relative connector directory reports a storage error on that owner and can be retried there, without writing under the cwd, picking another owner or blocking Core; an unavailable Mote configuration refuses only Mote operations; a Goal automation start failure is reported as a warning while Goal records and manual Agent input stay available.

## Desktop integration

Desktop launches this entry with its configuration file and connector directory, so the Host is Desktop's connector owner and Desktop Main opens no second one ([connector Host composition](../../docs/architecture/conversation.md#连接器的-host-组合与设置路由)). Calls the Host does not own itself, such as Browser pages and Capsule presentation, are forwarded to Desktop over `control.sock.desktop`; a phone's call is forwarded only with that device's forwarding authority. Goal methods other than `goal.focus`, and schedule, progress and automation methods, are never forwarded: if their owner is missing, they fail and the Goal, Session and operation are kept. The connector hosting Host is a different fact from a Binding's execution Host.

## Phone access

Phone access needs the durable file Session Store. The Host keeps the device registry (`agentmux-devices.json`) and the Relay key pair (`agentmux-relay-keypair.json`) next to it, serves the phone page and the Relay on port 8443, and issues connection-offer links that carry the Host's public key for end-to-end encryption. Each device is authenticated by its key; its requests run as the principal `HOST_ID:DEVICE_ID`, and each connection's queued requests are capped at 8 MiB and 128 frames. If the Mac has no LAN address or the Relay fails to start, `mobileAccess` says so, Agent sessions are unaffected, and the Host retries every 5 seconds. Only the first attempt may create the device registry; a later read failure never re-enrolls from scratch. Behavior is defined in [phone Relay connection](../../docs/design/behavior/public-control.md#手机版-relay-连接).

## Connectors

Credentials are stored through the protected Unix SDK call or `--secret-stdin`, never as command arguments or in logs, and the Runtime fence and person/device authorization apply:

```sh
amux --endpoint unix:/abs/runtime/control.sock connection credential store \
  --operation-id original-credential --secret-stdin
amux --endpoint unix:/abs/runtime/control.sock connection ls
```

Configuration, metadata, bindings, grants, intake and delivery use the methods in the [Connection protocol](../../docs/specs/connection-protocol.md). Starting the Host does not convert unsupported stored credentials ([Host credential storage](credential-storage.md)), move bindings or qualify a remote deployment.

## Mote avatars

With a Mote configuration, `space.mote.avatar.read` (`amux space mote avatar read --input -`) reads a saved PNG from its Mote resource without Desktop. The input names `target: { workspaceId, topicId, objectKey }` and optionally the save `operationId`; the result keeps the chosen avatar, appearance revision and save receipt, and reading never publishes a new avatar or settles an unknown save. A missing or corrupt PNG is reported separately from the saved choice, and a series PNG stays readable even when its series source cannot be checked. Node does not render theme, vector or 3D avatars or substitute another object: those report `MOTE_AVATAR_SOURCE_UNAVAILABLE`, and an unconfirmed local resource reports `MOTE_AVATAR_SOURCE_UNCONFIRMED`. Restore the resource and read again. Avatar failures never stop message text or Agent input; Desktop keeps the full appearance editor.
