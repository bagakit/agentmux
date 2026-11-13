import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.READING_CAUSE_MUTANT
if (mutant && mutant !== 'source-label') throw Error('Unknown original reading-cause mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/conversation-reading-failure-causes'), plugins: [...base.plugins!, {
  name: 'original-reading-cause-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^(apps\/(desktop|host)|packages\/(core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(file)) return
    let loaded = source
    if (mutant && file === 'packages/core/src/conversation-reader.ts') {
      const before = "fail('This operation does not continue the accepted window revision and original source cut.', 'AGENT_CONVERSATION_VIEW_EXPIRED')"
      if (source.split(before).length !== 2) throw Error('Original same-source window classification anchor changed')
      loaded = source.replace(before, "fail('This operation does not continue the accepted window revision and original source cut.')")
    }
    const marker = process.env.READING_CAUSE_LOADED
    if (!marker) return loaded === source ? undefined : { code: loaded, map: null }
    const sha = (s: string) => createHash('sha256').update(s).digest('hex'), row = { file, source: sha(source), loaded: sha(loaded), mutation: loaded === source ? null : mutant }
    return { code: "import{appendFileSync as __readCauseLoaded}from'node:fs';__readCauseLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-diagnosis-explanations.test.tsx'], testNamePattern: /keeps same-source reading conflicts precise/, passWithNoTests: false, fileParallelism: false, hookTimeout: 20000, testTimeout: 35000 } })
