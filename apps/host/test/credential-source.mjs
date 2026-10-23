import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const credentialSources = ['packages/connectors/src/connection-secrets.ts', 'apps/host/src/credential-encryption.ts', 'apps/host/src/credential-administration.ts']
export const credentialSupportingSources = ['packages/core/src/errors.ts', 'packages/core/src/delivery-log-id.ts', 'packages/core/src/object-id.ts', 'packages/identity/src/index.ts']
export const credentialMutants = {
  'namespace-not-authenticated': ['apps/host/src/credential-encryption.ts', "JSON.stringify(['amux.connection-vault.v1', options.namespace])", "JSON.stringify(['amux.connection-vault.v1'])"],
  'missing-master-replaced': ['apps/host/src/credential-encryption.ts', "if (options.database.prepare('SELECT 1 FROM connection_credential LIMIT 1').get()) return unavailable()", 'if (false) return unavailable()'],
  'linux-backend-falls-back': ['apps/host/src/credential-encryption.ts', "process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined", 'undefined'],
  'plaintext-ciphertext': ['apps/host/src/credential-encryption.ts', 'return Buffer.concat([FORMAT, iv, cipher.getAuthTag(), ciphertext])', 'return Buffer.from(value)'],
  'original-secret-conflict-ignored': ['packages/connectors/src/connection-secrets.ts', 'if (decrypted.result !== secret)', 'if (false)'],
  'sealed-target-ignored': ['apps/host/src/credential-administration.ts', 'return a.runtimeId === b.runtimeId && a.ownerInstanceId === b.ownerInstanceId', 'return true'],
  'sealed-administrator-ignored': ['apps/host/src/credential-administration.ts', "if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id || !context.runtimeFence || !sameTarget(context.runtimeFence, to))", 'if (false)'],
  'sealed-original-content-unchecked': ['apps/host/src/credential-administration.ts', 'original.purpose !== PURPOSE || original.operationId !== operationId || !sameTarget(target(original.target), to) || ', ''],
  'late-revocation-ignored': ['packages/connectors/src/connection-secrets.ts', 'await assertCurrent?.()\n      let concurrent', 'let concurrent'],
  'master-namespace-lock-ignored': ['apps/host/src/credential-encryption.ts', "if (lease && !(createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }).tryLock(lease.fd))", 'if (false)']
}
const hash = value => createHash('sha256').update(value).digest('hex')
export function credentialSource(root, file) {
  const relative = [...credentialSources, ...credentialSupportingSources].find(candidate => resolve(root, candidate) === file)
  if (!relative) return null
  const original = readFileSync(file, 'utf8'), mutant = process.env.AGENTMUX_CREDENTIAL_MUTANT
  let served = original
  if (mutant) {
    const mutation = credentialMutants[mutant]
    if (!mutation) throw Error('Unknown credential mutation')
    if (mutation[0] === relative) {
      if (original.split(mutation[1]).length !== 2) throw Error('Credential mutation no longer matches exactly once')
      served = original.replace(mutation[1], mutation[2])
    }
  }
  const receipt = { file: relative, originalSha256: hash(original), servedSha256: hash(served), mutant: mutant ?? null }
  if (process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT) appendFileSync(process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT, JSON.stringify(receipt) + '\n')
  return { contents: served, loader: 'ts', receipt }
}
