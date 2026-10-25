import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/query-feedback-stages', process.env.AGENTMUX_TEST_QUERY_MUTATION ?? 'positive'), plugins: [{
  name: 'query-stages-loaded-consumer', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = original, mutation: string | undefined
    if (process.env.AGENTMUX_TEST_QUERY_MUTATION && path === 'packages/connectors/src/publication-query-input.ts') {
      if (process.env.AGENTMUX_TEST_QUERY_MUTATION !== 'forget-reregister') throw Error('Unknown query feedback mutation')
      const before = '.run(anchor.operationId)'
      if (original.split(before).length !== 2) throw Error('Exact durable registration anchor must occur once')
      loaded = original.replace(before, ".run('unrelated-no-anchor')"); mutation = 'forget-reregister'
    }
    if (process.env.AGENTMUX_TEST_QUERY_LOADED && path.endsWith('.ts') && /^(packages\/(core|connectors)\/src|apps\/host\/src)\//u.test(path)) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }
      return { code: "import { appendFileSync as __queryStageLoaded } from 'node:fs'; __queryStageLoaded(" + JSON.stringify(process.env.AGENTMUX_TEST_QUERY_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (mutation) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/query-feedback-stages.integration.test.ts', 'packages/connectors/test/query-feedback-native.integration.test.ts', 'packages/connectors/test/feishu-query-feedback.test.ts'], maxWorkers: 1, testTimeout: 30000 } })
