import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...native, cacheDir: '.cache/public-input-alias', plugins: [...native.plugins!, { name: 'public-input-alias-proof', enforce: 'pre',
  transform(original, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path)) return
    let loaded = original
    const replace = (before: string, after: string) => { if (loaded.split(before).length !== 2) throw Error('Exact input alias mutation must load once'); loaded = loaded.replace(before, after) }
    if (path === 'packages/connectors/src/publication-store.ts') {
      if (process.env.PUBLIC_INPUT_ALIAS_MUTANT === 'accounting-disconnect') replace('this.accountInputAliases(boundary, units)', 'void units')
      if (process.env.PUBLIC_INPUT_ALIAS_MUTANT === 'source-key-conflict') {
        replace("AND json_extract(decision_json,'$.publicInputKey')=?", 'AND ? IS NOT NULL')
        replace('same(part.publicInputKey, key)', 'true')
      }
    }
    if (process.env.PUBLIC_INPUT_ALIAS_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.PUBLIC_INPUT_ALIAS_LOADED, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(loaded), ...(loaded !== original ? { mutation: process.env.PUBLIC_INPUT_ALIAS_MUTANT } : {}) }) + '\n')
    }
    if (loaded !== original) return loaded
  }
}], test: { ...native.test, include: ['packages/connectors/test/adopted-input-relay-consumer.test.ts', 'packages/connectors/test/public-input-alias.test.ts'], testTimeout: 30_000 } })
