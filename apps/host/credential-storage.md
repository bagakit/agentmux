# Host credential storage

`ConnectionSecrets` in `@agentmux/connectors` owns the original SQLite credential
table, operation IDs and opaque references. New values contain an explicit format
marker followed by verbatim UTF-8. They are permission-protected plaintext, not
encrypted bytes: the original Host directory is private to its current user
(0700), and the database and its exact SQLite sidecars use 0600. There is no OS
key service, master-key file, key cache or parallel JSON store.

An unsupported original ciphertext remains byte-for-byte with its original
operation and reference. Inspection reads only its reference. Resolution or a
same-operation write refuses that exact unsupported value without conversion,
overwrite, replacement identity or fallback. Existing ciphertext conversion is a
separate, explicitly authorized operation; merely starting this Host never
performs it.

`createCredentialAdministration` from
`@agentmux/host/credential-administration` lends that same owner to the original
Host's `ConnectionPort.credential`. Public `connection.credential.store` accepts
`{operationId, secret}` only from an authenticated person or device with the exact
current Runtime fence over the original Unix, SSH-to-Unix or end-to-end relay
transport. Managed Agents cannot administer credentials. Other transports refuse
only this write; original Agent work and ordinary connection reads remain
available. `connection.credential.inspect` accepts `{operationId}` and returns
`{receipt: {credentialRef} | null}`. Store returns `{credentialRef}` alone.
Ordinary configuration remains reference-only.

The CLI consumes plaintext only from stdin, in memory:

```sh
amux connection credential store --operation-id ORIGINAL_OPERATION --secret-stdin
amux connection credential inspect --operation-id ORIGINAL_OPERATION
```

Use the original selected Host endpoint. The CLI reads its current owner identity
before sending the exact fenced operation. Secret text is verbatim, including
whitespace and Unicode; it never belongs in arguments, environment variables,
input files, activity, device audit or diagnosis. No method reads a secret back.
The executing adapter resolves its reference through the same credential owner.

The original operation and receipt commit in the original SQLite transaction.
Same-operation/same-value continuation retains its reference; changed input
conflicts. After an unknown acknowledgement, inspect the original operation
before explicitly continuing it. A null inspection is only a current observation,
not proof an in-flight write cannot commit. Current authority is checked again
after asynchronous availability and before acquiring the writer. Storage or
authority failure does not recreate applications, Sessions, grants or bindings.
