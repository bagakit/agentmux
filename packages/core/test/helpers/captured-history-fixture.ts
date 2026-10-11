import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentCapturedTimelinePage, AgentCapturedTimelineRead, AgentCapturedTimelineRecord, AgentMuxStoredAgentSession, AgentTimelineItem, AgentTimelineMutation } from '../../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


export const capturedStorageSessionId = 'captured-storage-original'
export const capturedStorageRunId = 'captured-storage-original-run'

export function capturedStorageSession(root: string, id = capturedStorageSessionId): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, hostId: 'local', providerId: 'codex', executorId: 'codex',
    workspacePath: root, run: { runId: id === capturedStorageSessionId ? capturedStorageRunId : `run:${id}` }, retiredRuns: [],
    hookBindingId: `hook:${id}`, hookToken: `token:${id}`, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }
}

/** Three original producer forms. The fixture never runs the product retention reducer. */
export function capturedStorageRecords(perKind = 201, bodyBytes = 0, id = capturedStorageSessionId): AgentTimelineItem[] {
  return Array.from({ length: perKind }, (_, n) => {
    const at = _historyFixtureEpoch(0, 0, 10) + n * 3
    const body = `  exact original ${n} 中🙂\n${'x'.repeat(bodyBytes)}\n  `
    return [
      { id: `opaque/user:${n}#中`, agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete',
        createdAt: at, updatedAt: at, title: 'Original input', content: body, authorHuman: true, publicContent: 'confirmed',
        sourceDevice: { hostId: 'local', deviceId: 'original-device', name: 'Original device' } },
      { id: `opaque/tool:${n}#中`, agentSessionId: id, kind: 'tool_call', source: 'native-hook', status: 'streaming',
        createdAt: at + 1, updatedAt: at + 1, title: 'Original tool', toolName: 'shell', toolInput: `original input ${n}`,
        toolOutput: body },
      { id: `opaque/activity:${n}#中`, agentSessionId: id, kind: 'lifecycle', source: 'run-process', status: 'complete',
        createdAt: at + 2, updatedAt: at + 2, title: 'Accepted activity', activityState: {
          run: { runId: id === capturedStorageSessionId ? capturedStorageRunId : `run:${id}` },
          state: n % 2 ? 'done' : 'working', stateEnteredAt: at + 2 } }
    ] satisfies AgentTimelineItem[]
  }).flat()
}

export function capturedStorageSourcePath(storePath: string, id = capturedStorageSessionId): string {
  return join(dirname(storePath), 'agent-timelines', createHash('sha256').update(id).digest('base64url') + '.jsonl')
}

/** The old original file can still contain more complete mutations than its final retained window. */
export async function writeCapturedLegacyFixture(storePath: string, records: AgentTimelineItem[], tail = '', finalNewline = true) {
  const id = records[0]!.agentSessionId, initial = records.slice(0, 3), rest = records.slice(3)
  const snapshot = { version: 3, agentSessionId: id, revision: 31, items: initial }
  const mutations: AgentTimelineMutation[] = rest.map(item => ({ type: 'append', agentSessionId: id, item }))
  const target = records.find(item => item.kind === 'tool_call')!
  const completed = { ...target, status: 'complete' as const, createdAt: _historyFixtureEpoch(0, 10, 0), updatedAt: _historyFixtureEpoch(0, 20, 0), toolOutput: '  exact completion 中🙂\n  ' }
  mutations.push({ type: 'upsert', agentSessionId: id, item: completed })
  const original = Buffer.from([JSON.stringify(snapshot), ...mutations.map(mutation => JSON.stringify(mutation))].join('\n') + (finalNewline ? '\n' : '') + tail)
  const path = capturedStorageSourcePath(storePath, id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, original)
  return { path, original, target, completed: { ...completed, createdAt: target.createdAt }, expectedRevision: 31 + mutations.length,
    expected: records.map(item => item.id === target.id ? { ...completed, createdAt: target.createdAt } : item) }
}

export type CapturedHistoryPort = { readCapturedHistory(id: string, input?: AgentCapturedTimelineRead): Promise<AgentCapturedTimelinePage> }
export async function collectCapturedStorage(port: CapturedHistoryPort, id = capturedStorageSessionId, input: AgentCapturedTimelineRead = {}) {
  const all: AgentCapturedTimelineRecord[] = []
  let before: number | undefined, stream: AgentCapturedTimelinePage['stream'] | undefined
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await port.readCapturedHistory(id, { ...input, limit: input.limit ?? 37,
      ...(stream ? { epoch: stream.epoch, throughSequence: stream.sequence } : {}), ...(before === undefined ? {} : { beforeFirstSequence: before }) })
    if (page.agentSessionId !== id || stream && JSON.stringify(page.stream) !== JSON.stringify(stream)) throw new Error('Captured page changed its exact stream/cut.')
    stream ??= page.stream
    if (page.records.length > (input.limit ?? 37)) throw new Error('Captured page exceeded its requested record budget.')
    if (page.more && (!page.records.length || page.nextBeforeFirstSequence === null)) throw new Error('Captured continuation made no progress.')
    all.push(...page.records)
    if (!page.more) return { stream, records: all }
    const next = page.nextBeforeFirstSequence!
    if (before !== undefined && next >= before) throw new Error('Captured continuation moved backward or repeated.')
    before = next
  }
  throw new Error('Captured fixture exceeded its bounded continuation guard.')
}
