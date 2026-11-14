import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.focus-read-projection.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const selected = process.env.AGENTMUX_FOCUS_OBSERVATION_MUTANT
if (selected && selected !== 'wrong-document') throw Error('Unknown Focus observation source inverse')
const anchor = 'owner.renderer() !== renderer || owner.generation() !== generation'
let applied = false
export default defineConfig({ ...base, cacheDir: '.tmp/focus-observation-cache', plugins: [{
  name: 'actual-focus-observation-owner', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'apps/desktop/src/main/focus-observation.ts') return
    let code = original
    if (selected) {
      if (original.split(anchor).length !== 2) throw Error('One exact original document fence required')
      code = original.replace(anchor, 'false'); applied = true
    }
    const sha = (source: string) => createHash('sha256').update(source).digest('hex')
    if (process.env.AGENTMUX_FOCUS_OBSERVATION_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_OBSERVATION_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: selected ?? null }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Actual Focus observation inverse was not consumed') }
}],
  test: { ...base.test, include: ['apps/desktop/test/focus-observation.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
