import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(exports).map(([key, value]) => ({ find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) })).sort((a,b) => b.find.length-a.find.length)
const component = 'apps/desktop/src/renderer/src/components/MailboxCollaboration.tsx'
const changes = {
 lease: [component, 'live.current.active && live.current.owner === visibilityOwner && request === current', 'true'],
 handler: [component, 'live.current.active && live.current.owner === visibilityOwner && selectionLease.current === selectionOwner', 'live.current.active'],
 merge: [component, '...(previous?.dispatches ?? [])', '...[]'],
 cursor: [component, 'loadPage(listIssue.cursor, listIssue.pages, listIssue.extend)', 'loadPage(null, listIssue.pages, listIssue.extend)'],
 keep: [component, 'setDetail({ source, loading: true, issue: null })', 'setRecord(null); setDetail({ source, loading: true, issue: null })'],
 source: [component, 'if (result.hostId !== reference.hostId || result.dispatch.sourceMessageId !== source || result.source.envelope.messageId !== source ||\n        result.dispatch.ownerAgentSessionId !== reference.agentSessionId && result.dispatch.workerAgentSessionId !== reference.agentSessionId)', 'if (false)'],
 participant: [component, 'result.participantSessionId !== reference.agentSessionId', 'false'],
 scroll: [component, 'if (viewport) viewport.scrollTop = 0;', ''],
 fileSource: [component, '...(reading?.describeSpeaker ? { describeSpeaker: reading.describeSpeaker } : {})', '...reading'],
 runtimeParticipant: ['apps/desktop/src/main/runtime-controller.ts', 'original.dispatch.ownerAgentSessionId !== reference.agentSessionId && original.dispatch.workerAgentSessionId !== reference.agentSessionId', 'false'],
 runtimeHost: ['apps/desktop/src/main/runtime-controller.ts', 'this.configuredClient(reference.hostId).listDispatches', "this.configuredClient('local').listDispatches"],
 preload: ['apps/desktop/src/preload/index.ts', "ipcRenderer.invoke('sessions:dispatch', session, sourceMessageId)", "ipcRenderer.invoke('sessions:dispatches', session, sourceMessageId)"],
 ipc: ['apps/desktop/src/main/ipc.ts', 'args.runtime.sessionDispatch(session, sourceMessageId)', 'args.runtime.sessionDispatches(session)'],
 renderer: ['apps/desktop/src/renderer/src/lib/api.ts', '...preload.sessions,', '...preload.sessions, dispatch: undefined,']
} as const
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: process.env.A2A_PRODUCTION_BRIDGE ? 'false' : 'true' }, resolve: { conditions: ['browser'], alias: coreAliases },
 plugins: [{ name: 'original-mailbox-source-mutations', enforce: 'pre', transform(source,id) {
  const mutation = process.env.MAILBOX_COLLABORATION_MUTATION as keyof typeof changes | undefined
  if (!mutation) return
  assert.ok(changes[mutation], 'Known original-source mutation'); const [path,needle,replacement] = changes[mutation]
  if (relative(root,id) !== path) return
  assert.equal(source.split(needle).length-1,1, 'Unique original implementation mutation')
  if (process.env.MAILBOX_COLLABORATION_HITS) appendFileSync(process.env.MAILBOX_COLLABORATION_HITS,path+'\n')
  return { code: source.replace(needle,replacement), map: null }
 } }], test: { include: [process.env.A2A_PRODUCTION_BRIDGE ? 'apps/desktop/test/mailbox-collaboration-bridge.test.tsx' : 'apps/desktop/test/mailbox-collaboration.test.tsx'], setupFiles: [resolve(root,'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
