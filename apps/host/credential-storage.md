# Host credential storage

This page describes how the connector Host stores platform credentials (bot tokens and app secrets). The behavior it implements is defined in [credential storage and format handover](../../docs/design/behavior/conversation-channels.md#凭据存储与格式交接); method semantics are in the [Connection protocol](../../docs/specs/connection-protocol.md#凭据).

## Storage

[`ConnectionSecrets`](../../packages/connectors/src/connection-secrets.ts) in `@agentmux/connectors` stores each credential in the Host's connection SQLite database, together with its operation ID and an opaque `credentialRef`. A stored value is a format marker followed by the secret's UTF-8 bytes. It is plaintext protected by file permissions, not encryption: the connection directory is private to the current user (`0700`), and the database and its SQLite sidecar files are `0600`. File permissions do not encrypt copies or backups of the database, and they do not protect a value from another process running as the same user. There is no OS keychain, master-key file, key cache or separate JSON store.

A value in an older, unsupported format stays byte-for-byte as it was, with its operation and reference. Inspecting it returns only the reference; resolving it, or writing the same operation again, refuses that value without converting, overwriting or replacing it. Converting old values is a separate local maintenance step that a person runs explicitly (`apps/desktop/scripts/migrate-connection-credentials.mjs`); starting the Host never runs it.

## Writing and inspecting

`createCredentialAdministration` from `@agentmux/host/credential-administration` lends this store to the Host's `ConnectionPort.credential`.

- `connection.credential.store` accepts `{ operationId, secret }` and returns only `{ credentialRef }`. It requires an authenticated person or device, the current Runtime fence, and a Unix connection (including SSH forwarded to Unix) or the end-to-end encrypted Relay. Managed Agents cannot store credentials. Other transports are refused for this write only; Agent work and ordinary connection reads continue.
- `connection.credential.inspect` accepts `{ operationId }` and returns `{ receipt: { credentialRef } | null }`.
- No method reads a secret back. The executing adapter resolves a reference through the same store. Ordinary connection configuration contains only the reference.

The CLI reads the secret from stdin only and keeps it in memory:

```sh
amux connection credential store --operation-id ORIGINAL_OPERATION --secret-stdin
amux connection credential inspect --operation-id ORIGINAL_OPERATION
```

Use the endpoint of the Host that owns the connection; the CLI reads that Host's current owner identity before sending the fenced operation. The secret is taken verbatim, including whitespace and Unicode, and never belongs in arguments, environment variables, input files, activity records, device audit or diagnostics.

## Receipts and recovery

The operation and its receipt commit in the same SQLite transaction. Repeating an operation with the same value returns the same reference; repeating it with a different value is a conflict. After an unknown acknowledgement, inspect the original operation before continuing it. A `null` inspection describes the current state only; it does not prove that an in-flight write will not commit. The Host checks the caller's authority again after waiting for storage and before taking the writer. A storage or authority failure never recreates applications, Sessions, grants or bindings.
