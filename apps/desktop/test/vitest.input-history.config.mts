import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
 'query-target': ['apps/desktop/src/main/runtime-controller.ts', "{ ...options, hostId: 'local', agentSessionId: control.agentSessionId }", "{ ...options, hostId: 'local', agentSessionId: 'foreign-agent' }"],
 'query-error-code': ['apps/desktop/src/main/ipc.ts', 'return sessionInputOperationResult(() => historyReads.read(event.sender, token, signal => args.runtime.readSessionHistory(reference, options, signal)))', 'return historyReads.read(event.sender, token, signal => args.runtime.readSessionHistory(reference, options, signal))'],
 'cancel-reader': ['apps/desktop/src/main/session-history-read.ts', 'this.reads.get(`${senderId}:${token}`)?.()', 'void token'],
 'retained-native-seed': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', "const initialMessages = [...native.messages.filter(message => message.source.kind === 'native'), ...captured]", "const initialMessages = [...(native.nativeHistoryPage ? projectSessionUserMessages({ agentSessionId: sid, historyPage: native.nativeHistoryPage }) : []), ...captured]"],
 'native-list': ['packages/client-ui/src/lib/use-agent-input-history.ts', "['captured', 'native']", "['captured']"],
 'page-target': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', "if (page.hostId !== control.hostId || page.agentSessionId !== sid)", 'if (false)'],
 'arrow-query': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'direction, draft, inputHistory.entries)', 'direction, draft)'],
 'fill-original-draft': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', "(useAppStore.getState().agentComposerDrafts[sessionId] ?? '') !== result.draft", 'false'],
 'typed-complete': ['packages/client-ui/src/lib/use-agent-input-history.ts', 'complete: page.scan!.complete', 'complete: true']
} as const
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { conditions: ['browser'] }, plugins: [{
 name: 'actual-input-history-source', enforce: 'pre', transform(source, id) {
  const path = id.split('?')[0]!
  if (!path.startsWith(root + '/apps/desktop/src/') && !path.startsWith(root + '/packages/client-ui/src/')) return
  let code = source
  const name = process.env.AGENTMUX_INPUT_HISTORY_MUTANT as keyof typeof mutations | undefined
  if (name) { const change = mutations[name]; assert.ok(change, 'Known input history mutation'); if (path === resolve(root, change[0])) {
   assert.equal(source.split(change[1]).length - 1, 1, 'Unique loaded production mutation'); code = source.replace(change[1], change[2])
  } }
  if (process.env.AGENTMUX_INPUT_HISTORY_LOADS) appendFileSync(process.env.AGENTMUX_INPUT_HISTORY_LOADS, JSON.stringify({ path: relative(root, path), sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex'), mutation: name ?? null, transformed: source !== code }) + '\n')
  if (code !== source) return { code, map: null }
 }
}], test: { include: ['apps/desktop/test/composer-history-live-seed.test.tsx', 'apps/desktop/test/composer-input-history.integration.test.tsx', 'apps/desktop/test/composer-input-history-races.test.tsx', 'apps/desktop/test/history-query-lifetime.test.ts', 'apps/desktop/test/retired-session-history-ipc.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')], globalSetup: [resolve(root, 'vitest.dist-freshness.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 } })
