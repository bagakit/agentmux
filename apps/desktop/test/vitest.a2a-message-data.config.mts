import { defineConfig } from 'vitest/config'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const alias = Object.entries(exports).map(([key, value]) => ({ find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) })).sort((a,b) => b.find.length-a.find.length)
const mutations: Record<string, [string, string, string]> = {
  notifyHost: ['src/main/runtime-controller.ts', 'this.configuredClient(reference.hostId).notifyMessages(', "this.configuredClient('replacement-host').notifyMessages("],
  notifyMid: ['src/main/runtime-controller.ts', 'messageIds: [messageId]', "messageIds: ['replacement-mid']"],
  notifyTrust: ['src/main/ipc.ts', "handleWithEvent('sessions:notifyMessage', async (event, session: import('../shared/contracts.js').SessionHistoryReference, messageId: string, operationId: string) => {\n    assertManualPromptSenderTrusted(event.sender, contents)", "handleWithEvent('sessions:notifyMessage', async (event, session: import('../shared/contracts.js').SessionHistoryReference, messageId: string, operationId: string) => {\n    void event"],
  notifyInspectRun: ['src/main/runtime-controller.ts', 'key.expectedRun.runId !== message.envelope.recipientRunId', 'false'],

  participant: ['src/main/runtime-controller.ts', '.listMessages({ ...options, participantSessionId: reference.agentSessionId })', ".listMessages({ ...options, participantSessionId: 'other' })"],
  readParticipant: ['src/main/runtime-controller.ts', 'if (message && message.envelope.senderSessionId !== reference.agentSessionId && message.envelope.recipientSessionId !== reference.agentSessionId)', 'if (false && message && message.envelope.senderSessionId !== reference.agentSessionId && message.envelope.recipientSessionId !== reference.agentSessionId)'],
  preload: ['src/preload/index.ts', "ipcRenderer.invoke('sessions:message', session, messageId)", "ipcRenderer.invoke('sessions:messages', session, messageId)"],
  messageId: ['src/main/runtime-controller.ts', '.readMessage({ messageId })', ".readMessage({ messageId: 'replacement-message' })"],
  eventParticipant: ['src/main/runtime-controller.ts', '.listMessageEvents({ ...options, participantSessionId: reference.agentSessionId })', ".listMessageEvents({ ...options, participantSessionId: 'other' })"],
  eventHost: ['src/main/runtime-controller.ts', 'this.configuredClient(reference.hostId).listMessageEvents(', "this.configuredClient('replacement-host').listMessageEvents("],
  eventWindow: ['src/main/runtime-controller.ts', '.listMessageEvents({ ...options, participantSessionId: reference.agentSessionId })', '.listMessageEvents({ participantSessionId: reference.agentSessionId })'],
  eventPreload: ['src/preload/index.ts', "ipcRenderer.invoke('sessions:messageEvents', session, options)", "ipcRenderer.invoke('sessions:messages', session, options)"],
  eventTrust: ['src/main/ipc.ts', "requireTrustedSender('sessions:messageEvents', event)", 'void event'],
  spawnParticipant: ['src/main/runtime-controller.ts', '.listAgentSpawns({ ...options, participantSessionId: reference.agentSessionId })', ".listAgentSpawns({ ...options, participantSessionId: 'other' })"],
  spawnHost: ['src/main/runtime-controller.ts', 'this.configuredClient(reference.hostId).listAgentSpawns(', "this.configuredClient('replacement-host').listAgentSpawns("],
  spawnQuery: ['src/main/runtime-controller.ts', '.listAgentSpawns({ ...options, participantSessionId: reference.agentSessionId })', ".listAgentSpawns({ direction: 'creator', participantSessionId: reference.agentSessionId })"],
  spawnPreload: ['src/preload/index.ts', "ipcRenderer.invoke('sessions:spawns', session, options)", "ipcRenderer.invoke('sessions:messages', session, options)"],
  spawnTrust: ['src/main/ipc.ts', "requireTrustedSender('sessions:spawns', event)", 'void event']
}
const applied: Array<{ file: string; original: string; changed: string }> = []
const sources: Record<string, string> = {}
const evidence = process.env.AGENTMUX_MESSAGE_DATA_EVIDENCE
const mutation = process.env.AGENTMUX_TEST_MESSAGE_DATA_MUTATION
if (mutation && !mutations[mutation]) throw new Error(`Unknown message data mutation: ${mutation}`)
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, resolve: { conditions: ['browser'], alias },
  plugins: [{ name: 'message-data-proof-mutation', enforce: 'pre', transform(code, id) {
    const sourceFile = id.split('?')[0]!
    if (sourceFile.startsWith(root + '/') && !sourceFile.includes('/node_modules/') && !sourceFile.includes('/.tmp/')) sources[relative(root, sourceFile)] = createHash('sha256').update(readFileSync(sourceFile)).digest('hex')
    if (!mutation) return
    const [file, before, after] = mutations[mutation]!
    if (!id.endsWith(file)) return
    if (code.split(before).length !== 2) throw new Error(`Mutation anchor must occur once: ${mutation}`)
    const changed = code.replace(before, after)
    applied.push({ file, original: createHash('sha256').update(code).digest('hex'), changed: createHash('sha256').update(changed).digest('hex') })
    return changed
  } }],
  test: { ...(evidence ? { reporters: ['default', 'json', { onFinished() { mkdirSync(evidence, { recursive: true }); writeFileSync(resolve(evidence, 'mutation.json'), JSON.stringify({ mutation: mutation ?? null, applied, sources })); if (mutation) assert.equal(applied.length, 1) } }], outputFile: { json: resolve(evidence, 'results.json') } } : {}), include: ['apps/desktop/test/a2a-message-data-bridge.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
