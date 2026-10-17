import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const alias = Object.entries(exports).map(([key, value]) => ({ find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) })).sort((a,b) => b.find.length-a.find.length)
const mutations: Record<string, [string, string, string]> = {
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
const mutation = process.env.AGENTMUX_TEST_MESSAGE_DATA_MUTATION
if (mutation && !mutations[mutation]) throw new Error(`Unknown message data mutation: ${mutation}`)
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, resolve: { conditions: ['browser'], alias },
  plugins: mutation ? [{ name: 'message-data-proof-mutation', enforce: 'pre', transform(code, id) {
    const [file, before, after] = mutations[mutation]!
    if (!id.endsWith(file)) return
    if (code.split(before).length !== 2) throw new Error(`Mutation anchor must occur once: ${mutation}`)
    return code.replace(before, after)
  } }] : [],
  test: { include: ['apps/desktop/test/a2a-message-data-bridge.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
