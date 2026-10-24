import { defineConfig } from 'vitest/config'
import source from './vitest.publication-continuity.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutation = process.env.INPUT_CONTEXT_CONTINUITY_MUTANT
if (mutation && mutation !== 'root-disconnect') throw Error('Unknown original context continuity mutation')
export default defineConfig({ ...source, cacheDir: '.cache/input-context-continuity', plugins: [...source.plugins!, {
  name: 'original-input-context-continuity', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path)) return
    let code = original
    if (mutation && path === 'packages/connectors/src/ingress-context.ts') {
      const before = 'record.group?.target?.publicationRevision ?? revision'
      if (code.split(before).length !== 2) throw Error('Exact original context root must load once')
      code = code.replace(before, 'revision')
    }
    if (process.env.INPUT_CONTEXT_CONTINUITY_LOADED) {
      const sha = (body: string) => createHash('sha256').update(body).digest('hex')
      appendFileSync(process.env.INPUT_CONTEXT_CONTINUITY_LOADED, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(code), ...(code !== original ? { mutation } : {}) }) + '\n')
    }
    return code === original ? undefined : code
  }
}], test: { ...source.test, include: ['packages/connectors/test/ingress-context.test.ts', 'packages/connectors/test/input-context-continuity-consumer.test.ts', 'packages/connectors/test/channel-context-consumer.test.ts'], testTimeout: 35_000 } })
