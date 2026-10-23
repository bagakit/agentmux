# Host credential storage

`ConnectionSecrets` in `@agentmux/connectors` owns encrypted credential bytes and
their original SQLite operations. `createHostCredentialEncryption` from
`@agentmux/host/credential-encryption` supplies the Node OS backend to that same
database. Its stable namespace identifies the original database, independently
of a client, process instance or release. The embedding retains the original
database path and private filesystem permissions.

The backend uses `@napi-rs/keyring` for a 32-byte master key and Node AES-256-GCM
for the SQLite ciphertext. Linux explicitly requires Secret Service; it does not
fall back to kernel keyutils. A reachable, unlocked OS secret service is required
on the executing Host. The master key is not saved in an ordinary file or cached
for subsequent credential operations. Initial creation uses the original
database namespace lease without holding a SQLite writer across OS authorization.

Unavailable OS access, an absent key for existing data, and unsupported encrypted
formats retain the original bytes, references and operations. Reading never
converts or re-encrypts them. Existing encrypted data needs its own explicitly
authorized conversion before changing its encryption format. Restore the original
backend and inspect the original operation; do not recreate the connection or
copy another Host's key.

`createCredentialAdministration` and `sealConnectionCredential` are exported from
`@agentmux/host/credential-administration`. They provide an embedding port for
trusted credential entry, separate from reference-only connection configuration:

- The original Host instance supplies its runtime identity, credential owner and
  receiving transport's actual frame budget.
- `key(context)` returns its temporary X25519 public key. A trusted Main or CLI
  seals the secret in memory using X25519, HKDF-SHA256 and AES-256-GCM.
- `store(envelope, context)` verifies the sealed purpose, original operation and
  exact target, then calls the same `ConnectionSecrets.store`. Its internal
  current-authority callback is forwarded through any service facade and checked
  after OS waits, before a new SQLite write.
- `inspect(operationId, context)` returns only the original credential reference.
  A new Host instance cannot decrypt an old instance's entry envelope, while the
  original committed operation remains inspectable and resolvable.

The embedding supplies context from its authenticated transport: an original
person or device, no managed Agent caller, the exact runtime fence and current
authorization. Business JSON cannot supply that context. This module does not
mount public RPC methods, authorize external actors or manage Agent input.
Plaintext credentials stay out of public DTOs, logs, command arguments,
environment variables and ordinary files. Unknown write acknowledgements retain
their original operation for inspection.
