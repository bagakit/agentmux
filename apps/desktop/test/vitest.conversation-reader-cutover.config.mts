import base from './vitest.conversation-unified-consumers.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'swallow-latest-intent': ['packages/client-ui/src/lib/use-conversation-view.ts', "if (current.inFlight && (kind === 'changes' || kind === 'resume')) return current.inFlight", 'if (current.inFlight) return current.inFlight'],
  'accept-superseded-read': ['packages/client-ui/src/lib/use-conversation-view.ts', 'const isCurrent = () => alive() && current.request === requestController && !requestSignal.aborted', 'const isCurrent = () => alive()'],
  'accept-other-view': ['packages/client-ui/src/lib/use-conversation-view.ts', "if (prior && kind !== 'latest')", 'if (false && prior)'],
  'read-hidden-view': ['packages/client-ui/src/lib/use-conversation-view.ts', 'if (!active || !reference || !client) return', 'if (!reference || !client) return'],
  'lose-observer-reconnect': ['packages/client-ui/src/lib/use-conversation-view.ts', "current.retryTimer = setTimeout(() => { current.retryTimer = null; void read('resume') }, current.retryDelay)", 'current.retryTimer = setTimeout(() => { current.retryTimer = null }, current.retryDelay)'],
  'promote-unjoined-observation': ['packages/client-ui/src/components/CapturedConversationMessage.tsx', "compact={replyObservation?.compact ?? record?.role === 'observation'}", 'compact={false}'],
  'replace-pinned-version': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'record.id === pinned.id && record.event?.revision === pinned.event?.revision', 'record.id === pinned.id'],
  'freeze-preloaded-head': ['packages/client-ui/src/lib/use-conversation-view.ts', 'current.historical = Boolean(complete.window.anchor || complete.window.navigation.newer)', 'current.historical = true'],
  'follow-exact-anchor': ['packages/client-ui/src/lib/use-conversation-view.ts', 'complete.window.anchor || complete.window.navigation.newer', 'complete.window.navigation.newer'],
  'lose-navigation-catch-up': ['packages/client-ui/src/lib/use-conversation-view.ts', 'if (wasHistorical && !current.historical) current.dirty = true', 'if (wasHistorical && !current.historical) current.dirty = false']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-reader-cutover', plugins: [...base.plugins ?? [], {
  name: 'reader-consumer-source-mutations', enforce: 'pre', transform(source, id) {
    const mutation = process.env.AGENTMUX_READER_MUTATION, path = relative(root, id.split('?')[0]!)
    if (!mutation) return
    const change = changes[mutation]
    if (!change) throw Error('Unknown Reader consumer mutation: ' + mutation)
    if (path !== change[0]) return
    if (source.split(change[1]).length !== 2) throw Error('Missing unique Reader consumer mutation anchor: ' + mutation)
    const code = source.replace(change[1], change[2]), sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_READER_LOADED) appendFileSync(process.env.AGENTMUX_READER_LOADED,
      JSON.stringify({ path, mutation, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    return { code, map: null }
  }
}], test: { ...base.test,
  include: ['apps/desktop/test/conversation-reader-cutover.test.tsx'], testTimeout: 15000, passWithNoTests: false } })
