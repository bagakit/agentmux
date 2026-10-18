import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import base from '../scripts/fixtures/a2a-reference-reading/vitest.owning.config.mts'
import { originalReadingMutations } from '../scripts/a2a-original-reading-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_ORIGINAL_READING_MUTATION
const edit = originalReadingMutations.find(item => item.name === mutation)
if (mutation && !edit) throw new Error('Unknown original reading mutation: ' + mutation)
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/a2a-original-reading/vite-' + (mutation ?? 'baseline')),
  plugins: [...(base.plugins ?? []), { name: 'original-reading-compiler-input', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    const original = code
    if (edit && file === resolve(root, edit.path)) {
      if (code.split(edit.before).length !== 2) throw new Error('Mutation must match one exact production behavior: ' + edit.name)
      code = code.replace(edit.before, edit.after)
    }
    const output = process.env.AGENTMUX_ORIGINAL_READING_LOADED
    if (output) {
      mkdirSync(dirname(output), { recursive: true })
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(output, JSON.stringify({ path: relative(root, file), original: hash(original), compiled: hash(code) }) + '\n')
    }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/client-ui/test/a2a-original-reading.test.tsx', 'packages/client-ui/test/a2a-reference-reading.test.tsx'] }
})
