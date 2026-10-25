import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.persistence-inputs.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts'
const mutation = process.env.AGENTMUX_DRAFT_PERSISTENCE_MUTATION
if (mutation && mutation !== 'eager-encoding') throw Error('Unknown draft persistence mutation')
export default defineConfig({ ...base, cacheDir: '.cache/draft-persistence-' + (mutation ?? 'candidate'),
  plugins: [...base.plugins ?? [], { name: 'draft-persistence-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/')) return
    let code = source
    if (path === owner && mutation) {
      const anchor = 'pending.set(name, value)'
      if (source.split(anchor).length !== 2) throw Error('Missing original writer mutation anchor')
      code = source.replace(anchor, 'JSON.stringify(value); ' + anchor)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_DRAFT_PERSISTENCE_LOADED) appendFileSync(process.env.AGENTMUX_DRAFT_PERSISTENCE_LOADED,
      JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), mutation: source === code ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/ui-persistence-writer.test.ts', 'apps/desktop/test/workbench-storage-commit.test.ts'],
    passWithNoTests: false, fileParallelism: false }
})
