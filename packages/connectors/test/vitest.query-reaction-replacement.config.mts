import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = native.root!
const mutations = {
  'old-metrics-outcome': { path: 'packages/connectors/src/publication-query-feedback.ts', before: 'if (!item.turnId || !item.turnOutcome) continue', after: "if (!item.turnId || item.metrics?.scope !== 'turn' || item.metrics.status !== 'completed') continue" },
  'omit-failure-retirement': { path: 'packages/connectors/src/publication-query-feedback.ts', before: "['completed', 'failed', 'interrupted']", after: "['completed']" },
  'skip-retirement': { path: 'packages/connectors/src/publication-query-feedback.ts', before: "if (rank >= confirmed || operation.state !== 'confirmed' || !operation.mapping?.reactionId) continue", after: 'continue /* Loaded business mutation: retain every historical marker. */' },
  'foreign-app': { path: 'packages/connectors/src/adapters/feishu/reaction.ts', before: 'operator.operator_id !== application.appId ||', after: '' }
} as const
const name = process.env.AGENTMUX_TEST_REACTION_MUTANT as keyof typeof mutations | undefined
const change = name ? mutations[name] : undefined
if (name && !change) throw Error('Unknown reaction replacement mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/query-reaction-replacement', name ?? 'positive'), plugins: [{
  name: 'reaction-replacement-loaded-consumer', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!), loadedFile = process.env.AGENTMUX_TEST_REACTION_LOADED
    let loaded = original
    if (change?.path === path) {
      if (original.split(change.before).length !== 2) throw Error('Exact reaction replacement mutation must occur once')
      loaded = original.replace(change.before, change.after)
    }
    if (loadedFile && /^(packages\/(core|connectors)\/src|apps\/host\/src)\/.+\.ts$/u.test(path)) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(change?.path === path ? { mutation: name } : {}) }
      return { code: "import { appendFileSync as __reactionLoaded } from 'node:fs'; __reactionLoaded(" + JSON.stringify(loadedFile) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== original) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: [
  'packages/connectors/test/query-feedback-stages.integration.test.ts',
  'packages/connectors/test/query-feedback-native.integration.test.ts',
  'packages/connectors/test/feishu-query-feedback.test.ts'
], maxWorkers: 1, testTimeout: 30000 } })
