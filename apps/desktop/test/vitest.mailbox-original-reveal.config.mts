import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const view = 'packages/client-ui/src/lib/use-conversation-view.ts'
const mutation = process.env.AGENTMUX_MAILBOX_REVEAL_MUTATION ?? ''
const mutations: Record<string, { owner: string; edits: readonly (readonly [string, string])[] }> = {
  'omit-navigation-demand': { owner: pane, edits: [
    ['(!!incomingReveal || !!revealRead) && observationVisible', '!!incomingReveal && observationVisible']
  ] },
  'omit-original-reader-wait': { owner: activity, edits: [
    ['    const reading = readingWindow.inspect()\n    if (conversationReading && (reading.loading || reading.inFlight || reading.watch.binding || reading.held || !reading.snapshot && !reading.error)) return\n', ''],
    ['      const current = readingWindow.inspect()\n      if (conversationReading && (current.loading || current.inFlight || current.watch.binding || current.held)) return\n', '']
  ] },
  'omit-exact-display': { owner: pane, edits: [
    ['setRevealRequest({ generation, record: itemRef, signal: readController.signal, sourceKey, displayId, isCurrent: current, complete: (located, error) => {',
      'setRevealRequest({ generation, record: itemRef, signal: readController.signal, sourceKey, displayId: null, isCurrent: current, complete: (located, error) => {']
  ] },
  'stale-reveal-error': { owner: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', edits: [
    ['error: settled?.error ?? null', 'error: view.error']
  ] },
  'observation-error-as-source-change': { owner: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', edits: [
    ["const sourceChanged = ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((view.error as (Error & { code?: string }) | null)?.code ?? '')",
      "const sourceChanged = [view.error, view.observationError].some(error => ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes((error as (Error & { code?: string }) | null)?.code ?? ''))"]
  ] },
  'omit-summary-exact-record': { owner: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', edits: [
    ['const pending = view.selectRecord(record, readOptions)', 'const pending = Promise.resolve()']
  ] },
  'omit-activity-exact-record': { owner: activity, edits: [
    ['void readingWindow.selectRecord(revealRequest.record, { signal: revealRequest.signal })', 'void Promise.resolve()']
  ] },
  'omit-activity-read-signal': { owner: activity, edits: [
    ['void readingWindow.selectRecord(revealRequest.record, { signal: revealRequest.signal })', 'void readingWindow.selectRecord(revealRequest.record)']
  ] },
  'omit-pending-continuation': { owner: view, edits: [
    ["const continuation = kind === 'changes' || kind === 'resume' ? current.pending?.admission && current.pending : null",
      'const continuation: PendingFrame | null = null']
  ] },
  'install-closed-observation': { owner: view, edits: [
    ['        if (installed.closed.aborted) {', '        if (false) {']
  ] }
}
if (mutation && !mutations[mutation]) throw Error('Unknown original Mailbox reveal mutation')
const cases = [
  ...[false, true].map(detail => `real Inbox captured action (detail=${detail}) locates receiving conversation rather than declared sender or duplicate native raw id`),
  ...[false, true].map(detail => `real Inputs native action (detail=${detail}) selects complete provider/session/record namespace with stable projection and handoff`),
  'an original queued unsent message keeps Send and shared body/Copy without inventing a conversation location or dispatch',
  ...['focus', 'mode', 'run', 'hidden'].map(change => `late native result is isolated from later ${change} intent or scope`),
  'later user wheel alone cancels the pending exact-node reveal without stealing its current focus',
  'focus on an equal-source message in another display is later intent rather than this reveal handoff',
  'the presented Mailbox reveals only its proven display occurrence, without broadcasting to another projection',
  'an already loaded native target joins current revalidation (failed) before declaring a location',
  ...["{ providerId: 'claude', nativeSessionId: 'native-a' }", "{ providerId: 'codex', nativeSessionId: 'native-b' }"].flatMap(source => [
    `a latest original read with no accepted Pane window rejects the old native tuple after source replacement ${source}`,
    `an accepted original view still locates its original record after durable source replacement ${source} without granting the new source`
  ]),
  'a changed public Session provider in the same Host/Session/Run cannot use the previously loaded native source',
  ...['local', 'connected-host'].map(route => `an Inputs record read from the original older Provider pages locates its exact record beyond the Pane recent window through ${route}`),
  'a later feed wheel cancels the original Activity record reply without replacing its visible window and a new explicit reveal still works',
  'a later feed wheel settles a hanging original Activity watch opening without waiting for its reply and a new explicit reveal keeps its observer alive',
  'a completed selection-held Activity record frame is discarded after a later feed wheel and a new explicit reveal still works',
  'same held original record resume and changes retain its navigation lease until cancellation restores only its prior frame and observer',
  'an original candidate observer closed while held is not installed and existing observation recovery keeps the original body readable'
]
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/mailbox-original-reveal'),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [...base.plugins ?? [], { name: 'original-mailbox-reveal-owner', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file), path = relative(root, actual)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    let loaded = source, applied: string | null = null, changes = 0
    const selection = mutations[mutation]
    if (selection && selection.owner === path) {
      for (const [from, to] of selection.edits) {
        if (loaded.split(from).length !== 2) throw Error('Missing exact original Mailbox reveal mutation: ' + mutation)
        loaded = loaded.replace(from, to); changes++
      }
      applied = mutation
    }
    if (process.env.AGENTMUX_MAILBOX_REVEAL_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_MAILBOX_REVEAL_LOADED, JSON.stringify({ path,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied, changes }) + '\n')
    }
    return loaded === source ? undefined : { code: loaded, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/mailbox-message-navigation.integration.test.tsx',
    'apps/desktop/test/mailbox-older-record-navigation.integration.test.tsx', 'apps/desktop/test/conversation-reader-cutover.test.tsx'],
    testNamePattern: new RegExp('(?:' + cases.map(escape).join('|') + ')$'),
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
