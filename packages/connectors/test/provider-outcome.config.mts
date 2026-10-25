import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = native.root!
const mutations = {
  'drop-narrow-captured-failure': { path: 'packages/connectors/src/publication-content.ts', before: 'if (failed && !options.selected) {', after: "if (failed && !options.selected && (!narrow || failed.original.kind === 'native')) {" },
  'drop-binding-captured-cut': { path: 'packages/connectors/src/room-binding.ts', before: 'const sourceFrontier = page.checkpoint', after: "const sourceFrontier = { ...page.checkpoint, frontier: { ...page.checkpoint.frontier, scope: { sources: page.scope.sources.filter(s => s.kind === 'native') }, cuts: native } }" },
  'hide-missing-captured-start': { path: 'packages/connectors/src/publication-store.ts', before: 'private retainMissingCapturedStart(boundary: PublicationBoundary): void {', after: 'private retainMissingCapturedStart(boundary: PublicationBoundary): void { return;' },
  'forget-failure-reference': { path: 'packages/connectors/src/publication-store.ts', before: 'if (retainedFailure && !qualified(', after: 'if (false && retainedFailure && !qualified(' },
  'failure-as-completed': { path: 'packages/connectors/src/publication-query-feedback.ts', before: 'query, item.turnOutcome.status, witness,', after: "query, 'completed', witness," },
  'drop-failure-card': { path: 'packages/connectors/src/publication-store.ts', before: 'const payload = plan.failure ?? representation(', after: 'const payload = representation(' },
  'ignore-captured-cut': { path: 'packages/connectors/src/publication-content.ts', before: "failed.original.kind === 'captured' && (", after: 'false && (' },
  'share-raw-error': { path: 'packages/connectors/src/publication-content.ts', before: "...(original.publicMessage ? { message: original.publicMessage } : {})", after: '...{ message: original.message }' },
} as const
// The raw-message mutant changes only the public summary source; the original fixture stays private.
const mutant = process.env.AGENTMUX_TEST_PROVIDER_OUTCOME_MUTANT
if (mutant && !(mutant in mutations)) throw Error('Unknown provider outcome consumer mutation')
const change = mutant ? mutations[mutant as keyof typeof mutations] : undefined
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/provider-outcome-connectors', mutant ?? 'positive'), plugins: [{
  name: 'provider-outcome-loaded-consumer', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original
    if (change?.path === path) {
      if (original.split(change.before).length !== 2) throw Error('Exact provider outcome mutation anchor must occur once')
      loaded = original.replace(change.before, change.after)
    }
    const marker = process.env.AGENTMUX_TEST_PROVIDER_OUTCOME_LOADED
    if (marker && /^(packages\/(core|connectors)\/src|apps\/host\/src)\/.+\.ts$/u.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(change?.path === path ? { mutation: mutant } : {}) }
      return { code: "import { appendFileSync as __providerOutcomeLoaded } from 'node:fs'; __providerOutcomeLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== original) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/query-feedback-native.integration.test.ts', 'packages/connectors/test/feishu-query-feedback.test.ts', 'packages/connectors/test/mote-chat-first-input.integration.test.ts'], maxWorkers: 1, testTimeout: 30000, passWithNoTests: false } })
