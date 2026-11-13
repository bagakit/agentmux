import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_OUTPUT_MUTATION ? JSON.parse(process.env.AGENTMUX_OUTPUT_MUTATION) : null
const selected = process.env.AGENTMUX_OUTPUT_SLICE === 'capture'
  ? ['apps/desktop/test/screenshot-sources.test.ts', 'apps/desktop/test/screen-capture.test.ts']
  : process.env.AGENTMUX_OUTPUT_SLICE === 'documents'
    ? ['apps/desktop/test/screenshot-original-files.test.ts', 'apps/desktop/test/system-screenshot-original.test.tsx']
    : ['apps/desktop/test/screenshot-files.test.ts', 'apps/desktop/test/system-screenshot-editor.test.ts']
export default defineConfig({
  cacheDir: resolve(root, '.tmp/screenshot-output-tests'),
  resolve: { alias: { '@agentmux/native-desktop/image': resolve(root, 'packages/native-desktop/src/image.ts') } },
  plugins: [{ name: 'loaded-output-owner', enforce: 'pre', load(id) {
    if (!mutation || relative(root, id.split('?')[0]) !== mutation.source) return
    const source = readFileSync(id.split('?')[0], 'utf8')
    if (source.split(mutation.from).length !== 2) throw new Error('The production mutation is not unique: ' + mutation.id)
    const changed = source.replace(mutation.from, mutation.to)
    if (process.env.AGENTMUX_OUTPUT_LOADED) appendFileSync(process.env.AGENTMUX_OUTPUT_LOADED,
      JSON.stringify({ source: mutation.source, hash: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return changed
  } }],
  test: { include: selected, environment: 'node', environmentMatchGlobs: [['**/system-screenshot-original.test.tsx', 'happy-dom']], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
