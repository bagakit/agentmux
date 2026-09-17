import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'

/** Real built-in Provider → public Client → FileStore, with no Runtime connection or model. */
export async function nativeHistoryFixture(
  providerId: 'claude' | 'pi',
  data: string | Buffer | ((root: string) => string)
) {
  const root = await mkdtemp(join(tmpdir(), `agentmux-${providerId}-history-`))
  const path = join(root, 'native.jsonl')
  await writeFile(path, typeof data === 'function' ? data(root) : data)
  const storePath = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-agent', providerId,
    executorId: providerId, hostId: 'local', workspacePath: root, run: { runId: 'unchanged-private-run' },
    retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const before = { native: await readFile(path), store: await readFile(storePath) }
  // Core cancellation settles the logical request before the physical FileStore read/sweep.
  // Trace the real reads so fixture removal waits for exactly those owned operations to drain.
  const physicalReads: Array<Promise<readonly unknown[]>> = []
  const read = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => {
    const reading = read()
    physicalReads.push(reading)
    return reading
  })
  const client = new AgentMuxClient({ store })
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) => vi.spyOn(kernel, name as 'start'))
  return { root, path, storePath, store, session, client, controls, before,
    bytes: async () => ({ native: await readFile(path), store: await readFile(storePath) }),
    close: async () => {
      await client.dispose()
      await Promise.allSettled(physicalReads)
      await rm(root, { recursive: true, force: true })
    } }
}

export const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n'
