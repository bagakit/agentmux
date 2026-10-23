import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export const credentialMutants = {
  'legacy-decoded': ['packages/connectors/src/connection-secrets.ts', "if (!Buffer.from(bytes).subarray(0, FORMAT.length).equals(FORMAT))", 'if (false)'],
  'original-secret-conflict-ignored': ['packages/connectors/src/connection-secrets.ts', 'if (this.value(original.ciphertext) !== secret)', 'if (false)'],
  'directory-mode-ignored': ['packages/connectors/src/connection-secrets.ts', '(directory.mode & 0o077) !== 0', 'false'],
  'database-mode-not-tightened': ['packages/connectors/src/connection-secrets.ts', 'chmodSync(owned, 0o600)', '/* mutation: leave exact database exposed */'],
  'late-revocation-ignored': ['packages/connectors/src/connection-secrets.ts', 'await assertCurrent?.()', '/* mutation: original authority omitted */'],
  'leaf-administrator-ignored': ['apps/host/src/credential-administration.ts', "if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id || !context.runtimeFence || context.runtimeFence.runtimeId !== options.target.runtimeId || context.runtimeFence.ownerInstanceId !== options.target.ownerInstanceId)", 'if (false)'],
  'leaf-transport-ignored': ['apps/host/src/credential-administration.ts', "if (write && context.transport !== 'unix' && context.transport !== 'relay')", 'if (false)'],
  'public-person-boundary-ignored': ['packages/core/src/public-rpc-service.ts', 'if (caller || !context.runtimeFence) throw new AgentMuxError', 'if (false) throw new AgentMuxError'],
  'public-fence-ignored': ['packages/core/src/public-rpc-service.ts', 'await this.assertRuntimeFence(context)\n        context.signal?.throwIfAborted()', 'context.signal?.throwIfAborted()'],
  'client-http-secret-sent': ['packages/core/src/public-rpc-client.ts', "if (method === 'connection.credential.store' && route.endpoint.transport === 'http')", 'if (false)'],
  'public-result-extra-secret': ['packages/core/src/connection-credential-codec.ts', "const row = object(value, ['credentialRef']);", 'const row = value;']
}
const hash = value => createHash('sha256').update(value).digest('hex')
export const credentialSources = ['packages/connectors/src/connection-secrets.ts', 'packages/connectors/src/connection-services.ts', 'apps/host/src/credential-administration.ts', 'apps/host/src/connections.ts', 'apps/host/src/host.ts', 'apps/host/src/device-authority.ts', 'packages/core/src/connection-credential-contract.ts', 'packages/core/src/connection-credential-codec.ts', 'packages/core/src/connection-credential-cli.ts', 'packages/core/src/connections-codec.ts', 'packages/core/src/connections-contract.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/index.ts']
export function credentialSource(root, file, source, consumer = 'vitest') {
  const path = relative(root, file.split('?')[0])
  if (!credentialSources.includes(path)) return null
  const original = source ?? readFileSync(file, 'utf8'), mutant = process.env.AGENTMUX_CREDENTIAL_MUTANT
  let served = original
  if (mutant) {
    const mutation = credentialMutants[mutant]; if (!mutation) throw Error('Unknown credential mutation')
    if (mutation[0] === path) {
      if (original.split(mutation[1]).length !== 2) throw Error('Credential mutation no longer matches exactly once: ' + path)
      served = original.replace(mutation[1], mutation[2])
    }
  }
  const receipt = { path, consumer, pid: process.pid, originalSHA: hash(readFileSync(file, 'utf8')), servedSHA: hash(served), ...(served !== original ? { mutant } : {}) }
  return { contents: served, receipt }
}
export function credentialTrace(receipt) { if (process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT) appendFileSync(process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT, JSON.stringify(receipt) + '\n') }
