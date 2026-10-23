import base from './vitest.conversation-unified-consumers.config.mts'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { mergeConfig } from 'vite'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'
const root = resolve(import.meta.dirname, '../../..')
const candidate = mergeConfig(base, { resolve: { alias: [candidateAlias(root, { browser: true, source: true })] } })
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
  'lose-navigation-catch-up': ['packages/client-ui/src/lib/use-conversation-view.ts', 'if (wasHistorical && !current.historical) current.dirty = true', 'if (wasHistorical && !current.historical) current.dirty = false'],
  'repeat-desktop-projection': ['apps/desktop/src/renderer/src/lib/session-conversation-window.ts',
    'useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])',
    'useMemo(() => view.snapshot ? projectConversationWindow(view.snapshot) : null, [view.snapshot])'],
  'repeat-mobile-projection': ['apps/mobile/src/conversation/use-hosted-conversation.ts',
    'useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])',
    'useMemo(() => view.snapshot ? projectConversationWindow(view.snapshot) : null, [view.snapshot])'],
  'repeat-focus-projection': ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
    'useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])',
    'useMemo(() => view.snapshot ? projectConversationWindow(view.snapshot) : null, [view.snapshot])']
}
// Capture the harness inputs before each controlled test clears inherited
// Core/Runtime authority; later transforms must use these exact original flags.
const mutation = process.env.AGENTMUX_READER_MUTATION
const readerLoaded = process.env.AGENTMUX_READER_LOADED
const acceptedReadingLoaded = process.env.AGENTMUX_ACCEPTED_READING_LOADED
const change = mutation ? changes[mutation] : undefined
if (mutation && !change) throw Error('Unknown Reader consumer mutation: ' + mutation)
export default defineConfig({ ...candidate, cacheDir: '.cache/conversation-reader-cutover', plugins: [...candidate.plugins ?? [], {
  name: 'reader-consumer-source-mutations', enforce: 'pre', transform(source, id) {
    if (!mutation && !acceptedReadingLoaded) return
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual), query = id.includes('?') ? id.slice(id.indexOf('?')) : ''
    const kind = !query && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? 'module' : 'resource'
    const applied = change && kind === 'module' && path === change[0]
    if (applied && source.split(change[1]).length !== 2) throw Error('Missing unique Reader consumer mutation anchor: ' + mutation)
    const code = applied ? source.replace(change[1], change[2]) : source
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (applied && readerLoaded) appendFileSync(readerLoaded,
      JSON.stringify({ path, mutation, originalSHA256: sha(source), sha256: sha(code) }) + '\n')
    if (acceptedReadingLoaded) appendFileSync(acceptedReadingLoaded,
      JSON.stringify({ path, kind, query, fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source),
        loadedSHA256: sha(code), mutation: applied ? mutation : null }) + '\n')
    return applied ? { code, map: null } : undefined
  }
}], test: { ...candidate.test,
  include: ['apps/desktop/test/conversation-reader-cutover.test.tsx'], testTimeout: 15000, passWithNoTests: false } })
