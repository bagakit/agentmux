import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_MUTATION
if (mutation && mutation !== 'audit-range') throw Error('Unknown publication recovery mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/publication-recovery-cost'), plugins: [{
  name: 'loaded-publication-recovery-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core\/dist|connectors\/(src|test))\//u.test(path)) return
    let code = source
    if (mutation && path === 'packages/connectors/src/publication-store.ts') {
      const method = source.match(/  nextUnconfirmed\([\s\S]*?\n  \}/u)?.[0]
      if (!method?.includes('SELECT MIN(ordinal)')) throw Error('Original recovery query seam missing')
      const originalQuery = `    return this.read(this.database.prepare(\`SELECT operation_json,state FROM connector_publication_operation
      WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied')
        AND state IN ('dispatching','unknown') AND ordinal>? \${projectionId === undefined ? "AND json_extract(operation_json,'$.reference.source.kind')!='binding-operation'" : 'AND projection_id=?'}
      ORDER BY ordinal LIMIT 1\`).get(...scopeKey(boundary), Number(cursor?.ordinal ?? 0), ...(projectionId === undefined ? [] : [projectionId])))`
      const cursorLine = method.split('\n').find(line => line.includes('const cursor ='))!
      code = source.replace(method, [method.split('\n')[0], cursorLine, originalQuery, '  }'].join('\n'))
    }
    if (process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENTMUX_TEST_PUBLICATION_RECOVERY_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['packages/connectors/test/publication-worker-consumer.test.ts'], testNamePattern: '^(publication recovery |a single slow inspector never gates independent speech)', fileParallelism: false, passWithNoTests: false } })
