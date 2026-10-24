import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { primaryReadingMutations } from '../scripts/fixtures/a2a-primary-reading/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_PRIMARY_READING_MUTATION
const edit = primaryReadingMutations.find(item => item.name === mutation)
if (mutation && !edit) throw Error('Unknown primary reading mutation: ' + mutation)
export default defineConfig({ ...base, cacheDir: resolve(root, '.local/a2a-primary-reading/vite-' + (mutation || 'baseline')),
  plugins: [...(base.plugins ?? []), { name: 'primary-reading-actual-input', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    let code = source
    if (edit && file === resolve(root, edit.path)) {
      if (source.split(edit.before).length !== 2) throw Error('Mutation must match exactly one loaded production behavior: ' + edit.name)
      code = source.replace(edit.before, edit.after)
    }
    const output = process.env.AGENTMUX_PRIMARY_READING_LOADED
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (output) appendFileSync(output, JSON.stringify({ path: relative(root, file), original: hash(source), compiled: hash(code) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: [
    'packages/client-ui/test/a2a-original-reading.test.tsx',
    'packages/client-ui/test/a2a-reference-reading.test.tsx',
    'apps/desktop/test/a2a-primary-reading-consumers.test.tsx'
  ] }
})
