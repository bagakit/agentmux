import { writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'

const root = resolve(import.meta.dirname, '../../../..')
const observed = new Set(['headless-runtime.js', 'node-publishing-owner.js', 'node-publishing.js', 'public-rpc-server.js', 'public-rpc-service.js'].map(name => 'packages/core/dist/' + name))
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:')) return result
  const path = relative(root, fileURLToPath(url))
  if (!observed.has(path)) return result
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'cluster-resources-owner-loaded.jsonl'), JSON.stringify({ path, processId: process.pid, originalSHA256: hash(readFileSync(fileURLToPath(url))), loadedSHA256: hash(result.source) }) + '\n', { mode: 0o600 })
  return result
} })
const { startHeadlessAgentMux } = await import('../../../../packages/core/dist/headless-runtime.js')

// Only this private fixture grants a stable test device transport. The original
// Core still owns all Node permissions, policy, sampling and public responses.
const owner = await startHeadlessAgentMux({
  socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'cluster-original.sock'),
  http: { host: '127.0.0.1', port: 0,
    authorize: request => request.headers.get('authorization') === 'Bearer private-cluster-device'
      ? { principal: { kind: 'device', id: 'private-cluster-resource-device' } } : null }
})
await writeFile(join(process.env.AGENTMUX_STATE_DIRECTORY, 'cluster-device-endpoint.json'), JSON.stringify(owner.server.httpAddress), { mode: 0o600 })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void owner.stop() })
