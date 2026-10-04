const sourceModule = process.env.AGENTMUX_TEST_DURABILITY_STORE_MODULE
if (!sourceModule) throw new Error('Private writer requires the exact source-bundled Session Store')
const { AgentMuxFileAgentSessionStore } = await import(sourceModule)
import { createRequire } from 'node:module'
import { open } from 'node:fs/promises'
import { once } from 'node:events'
const [mode, path, id] = process.argv.slice(2)
if (mode === 'hold') {
  const file = await open(path + '.lock', 'a+', 0o600)
  const native = createRequire(import.meta.url)('fs-native-extensions')
  if (!native.tryLock(file.fd)) throw new Error('Fixture could not own the writer lock')
  console.log('ready')
  await once(process.stdin, 'data')
  await file.close()
} else if (mode === 'insert') {
  console.log('ready')
  await once(process.stdin, 'data')
  const session = { kind: 'agent', agentSessionId: id, providerId: 'fixture', executorId: 'fixture',
    hostId: 'local', workspacePath: process.cwd(), run: { runId: 'run-' + id }, retiredRuns: [],
    hookBindingId: 'hook-' + id, hookToken: 'token-' + id, createdAt: 100, updatedAt: 100 }
  await new AgentMuxFileAgentSessionStore(path).compareAndSwap(null, session)
  console.log('saved')
}
