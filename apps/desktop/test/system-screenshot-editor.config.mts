import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SCREENSHOT_EDITOR_MUTATION ? JSON.parse(process.env.AGENTMUX_SCREENSHOT_EDITOR_MUTATION) : null
export default defineConfig({
  cacheDir: resolve(root, '.tmp/system-screenshot-editor-cache'),
  resolve: { alias: {
    '@agentmux/native-desktop/image': resolve(root, 'packages/native-desktop/src/image.ts'),
    '@agentmux/client-ui/theme': resolve(root, 'packages/client-ui/src/theme/index.ts')
  } },
  plugins: [{ name: 'system-screenshot-editor-private-mutation', enforce: 'pre', load(id) {
    const file = relative(root, id.split('?')[0])
    if (file !== 'apps/desktop/src/main/system-screenshot-editor.ts') return
    const source = readFileSync(id.split('?')[0], 'utf8')
    if (mutation && source.split(mutation.from).length !== 2) throw new Error('Non-unique production mutation: ' + mutation.id)
    const changed = mutation ? source.replace(mutation.from, mutation.to) : source
    if (process.env.AGENTMUX_SCREENSHOT_EDITOR_LOADED) appendFileSync(process.env.AGENTMUX_SCREENSHOT_EDITOR_LOADED,
      JSON.stringify({ file, original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(changed).digest('hex'), mutation: mutation?.id ?? null }) + '\n')
    return changed
  } }],
  test: { include: ['apps/desktop/test/system-screenshot-editor.test.ts', 'apps/desktop/test/browser-screenshot-compose.test.ts', 'apps/desktop/test/browser-screenshot-context.test.ts'], environment: 'node',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 }
})
