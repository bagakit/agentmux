import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SOURCE_RECOVERY_MUTATION
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const view = 'packages/client-ui/src/lib/use-conversation-view.ts'
const edits: Record<string, { owner: string; from: string; to: string }> = {
  'remove-failed-current-entry': { owner: activity,
    from: 'const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical || readingWindow.held || Boolean(readingWindow.error)',
    to: 'const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical || readingWindow.held' },
  'omit-held-current-entry': { owner: activity,
    from: 'const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical || readingWindow.held || Boolean(readingWindow.error)',
    to: 'const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical || Boolean(readingWindow.error)' },
  'current-without-latest-read': { owner: activity,
    from: 'if (readingWindow.historical || readingWindow.newerOutside || readingWindow.held || readingWindow.error) {',
    to: 'if (readingWindow.historical || readingWindow.newerOutside || readingWindow.held) {' },
  'retry-as-latest': { owner: view,
    from: ': operation.current(retryOperation.current.kind, retryOperation.current.selection, Boolean(value.observationError))',
    to: ": operation.current('latest', {}, Boolean(value.observationError))" }
}
if (mutation && !edits[mutation]) throw Error('Unknown source-recovery mutation')
const cases = [
  'retains an original body after a source rewrite and explicitly recovers its same raw identity',
  'keeps an explicit current recovery behind the original selection admission after a source rewrite',
  'keeps an explicit current recovery behind the original focus admission after a source rewrite',
  'does not execute a failed-cut current action while its original Activity consumer is hidden',
  'keeps a protected historical selection on Latest until its original Range is cleared',
  'cancels a superseded pending older page after explicit Current and rejects its late original result',
  'returns to an appended loaded tail without creating a false gap or another read',
  'keeps a latest action for a held-only current window and uses a real current read after the Range is cleared'
]
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/conversation-source-recovery-' + (mutation ?? 'positive')),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [{ name: 'actual-source-recovery-consumer', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual)
    let code = source
    if (mutation && path === edits[mutation]!.owner) {
      const { from, to } = edits[mutation]!
      if (source.split(from).length !== 2) throw Error('Expected one exact original source-recovery mutation')
      code = source.replace(from, to)
    }
    if (process.env.AGENTMUX_SOURCE_RECOVERY_LOADED) {
      const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_SOURCE_RECOVERY_LOADED, JSON.stringify({ path,
        fileSHA256: hash(readFileSync(actual)), originalSHA256: hash(source), loadedSHA256: hash(code),
        mutation: code === source ? null : mutation }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/activity-unified-history.integration.test.tsx'],
    testNamePattern: new RegExp('(?:' + cases.map(escape).join('|') + ')$'),
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
