import { readFile, stat } from 'node:fs/promises'
import { AgentProviderRegistry, defineAgentProvider } from '../../../../../packages/core/src/index.js'
import { nativeProcessFiles } from '../../../../../packages/core/src/agent-native-process.js'

const original = new AgentProviderRegistry().get('codex'), nativeId = 'private-check-in-native'
/** A private protocol adapter, reading only the transcript held by the real Run. */
export const checkInProvider = defineAgentProvider({
  catalog: { ...original.catalog, id: 'check-in-test', label: 'Private follow-up native', executable: process.execPath, expectedProcess: 'node', hookStrategy: { kind: 'native', installation: 'unmanaged' } },
  hook: original.hook,
  buildArgs: () => [process.env.SCHEDULE_PROBE_AGENT!],
  async discoverNativeSession(context) {
    const files = (await nativeProcessFiles(context.processId, context.signal)).filter(file => file.path.endsWith('/check-in-native.ndjson') && ['w','u'].includes(file.access ?? ''))
    if (files.length !== 1) return null
    const file = files[0]!, source = await stat(file.path, { bigint: true })
    if (source.dev !== file.device || source.ino !== file.inode) return null
    const header = JSON.parse((await readFile(file.path, 'utf8')).split('\n')[0]!)
    if (header.kind !== 'session' || header.id !== nativeId) return null
    return { handle: { kind: 'provider', providerId: 'check-in-test', sessionId: nativeId, transcriptPath: file.path },
      assertCurrent: async () => {
        const next = await nativeProcessFiles(context.processId, context.signal)
        if (!next.some(current => current.path === file.path && current.processId === file.processId && current.descriptor === file.descriptor && current.device === file.device && current.inode === file.inode && ['w','u'].includes(current.access ?? ''))) throw new Error('Actual private native source changed')
      } }
  },
  async readSessionHistoryPage(context) {
    context.signal.throwIfAborted()
    const bytes = await readFile(context.transcriptPath!), records = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    if (records[0].id !== context.source.nativeSessionId) throw new Error('Wrong original native source')
    const items = records.slice(1).filter(record => record.kind === 'input').map(record => ({ id: record.id, kind: 'user-message' as const, startedAt: record.createdAt, contentParts: [{ kind: 'text' as const, text: record.text }] }))
    return { source: context.source, items: items.slice(-context.limit), nextCursor: items.length > context.limit ? 'earlier-native-records' : null, sourceSizeBytes: bytes.length }
  },
  async readPromptExecutionEvidence(context) {
    if (context.nativeHandle?.kind !== 'provider' || context.nativeHandle.providerId !== 'check-in-test' || !context.nativeHandle.transcriptPath) return null
    const records = (await readFile(context.nativeHandle.transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), last = records.at(-1)
    if (records[0].id !== context.nativeHandle.sessionId || last.kind !== 'end') return null
    return { sourceId: nativeId, id: last.id, state: 'ended', endReason: 'completed' }
  }
})
