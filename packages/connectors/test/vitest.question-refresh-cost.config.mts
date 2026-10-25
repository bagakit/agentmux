import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import native from './vitest.feishu-question-card.config.mts'

const root = native.root!, mutation = process.env.QUESTION_REFRESH_MUTANT
if (mutation && !['whole-history', 'ignore-successor'].includes(mutation)) throw Error('Unknown Question refresh mutation')
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/question-refresh-cost', mutation ?? 'positive'), plugins: [{
  name: 'loaded-question-refresh-cost', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/connectors/src/conversation-actions.ts', 'packages/connectors/src/publication-store.ts', 'packages/connectors/src/publication-host.ts'].includes(path)) return
    let loaded = original
    if (mutation && path.endsWith('/conversation-actions.ts')) {
      const block = original.match(/    const rows = database.prepare\(`SELECT candidate.operation_json,candidate.state[\s\S]*?\.all\(binding.bindingId, binding.revision\)/u)?.[0]
      if (!block) throw Error('Exact production Question refresh query was not loaded')
      if (mutation === 'whole-history') loaded = original.replace(block, `    const rows = database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.kind')='question' AND ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? GROUP BY projection_id) AND json_extract(operation_json,'$.payload.status') IN ('pending','unconfirmed') ORDER BY ordinal LIMIT 100")
      .all(binding.bindingId, binding.revision, binding.bindingId, binding.revision)`)
      else loaded = original.replace(block, block.replace(/        AND NOT EXISTS \(SELECT 1[\s\S]*?successor.ordinal>candidate.ordinal\)/u, ''))
      if (loaded === original) throw Error('Question refresh mutation did not change the loaded source')
    }
    if (process.env.QUESTION_REFRESH_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), mutation: loaded === original ? null : mutation }
      return { code: "import { appendFileSync as __refreshLoaded } from 'node:fs'; __refreshLoaded(" + JSON.stringify(process.env.QUESTION_REFRESH_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (loaded !== original) return { code: loaded, map: null }
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/question-refresh-cost.test.ts'], testTimeout: 40000 } })
