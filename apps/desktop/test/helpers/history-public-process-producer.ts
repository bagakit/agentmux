import { fixtureData as _hygiene_fixtureData } from "../../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { expect, vi } from 'vitest'
import { AgentMuxClient } from '@agentmux/core'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { AgentSessionHistoryPageOptions } from '@agentmux/core'
import type { CtxmuxRunAdapter } from '../../../../packages/core/src/ctxmux-run-adapter'

/** Reuse the already-qualified readonly producer. It is a controlled protocol, not a vendor Writer. */
export async function createHistoryPublicProcessProducer() {
  const evidence = process.env.HISTORY_SOURCE_EVIDENCE ? resolve(process.env.HISTORY_SOURCE_EVIDENCE)
    : join(dirname(fileURLToPath(import.meta.url)), '../fixtures/history-native-process')
  const bytes = await readFile(join(evidence, 'public-pages.json'))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('7bfb5d76ccd44247d0067634709297993fa20ab8fc4e4f31156d6818ab388735')
  const recorded = _hygiene_fixtureData(JSON.parse(bytes.toString('utf8')))
  const home = await mkdtemp(join(tmpdir(), 'agentmux-private-history-process-'))
  const workspace = join(home, 'workspace'); await mkdir(workspace)
  const storePath = join(home, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: recorded.agentSessionId,
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: workspace,
    run: { runId: 'private-original-not-connected' }, retiredRuns: [], hookBindingId: 'private-history-hook',
    hookToken: 'private-history-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: recorded.source.nativeSessionId } })
  const before = await readFile(storePath), client = new AgentMuxClient({ store })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const controls = (['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const)
    .map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error('Forbidden Runtime control: ' + key) }))
  const requestsPath = join(home, 'requests.jsonl'), responsesPath = join(home, 'responses.jsonl')
  const read = (options?: AgentSessionHistoryPageOptions) => client.sessionHistoryPage(recorded.agentSessionId, {
    commandOverride: process.execPath, args: [join(evidence, 'readonly-producer.mjs')],
    env: { CODEX_HOME: home, AMX_NATIVE_PROCESS_REQUESTS: requestsPath, AMX_NATIVE_PROCESS_RESPONSES: responsesPath }, ...options
  })
  return { control: { hostId: 'local', agentSessionId: recorded.agentSessionId }, recorded, read,
    requests: () => readFile(requestsPath, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => _hygiene_fixtureData(JSON.parse(line)))),
    async close() {
      expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
      expect(await readFile(storePath)).toEqual(before)
      await client.dispose(); await rm(home, { recursive: true })
    }
  }
}
