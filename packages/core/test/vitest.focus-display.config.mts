import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const parser = resolve(root, 'packages/core/src/desktop-focus-parser.ts')
const mapping = "(key === 'displayWorkspaceId' ? 'workspaceId' : key) as keyof AgentMuxDesktopSpaceSelection"
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.tmp/focus-display-vitest-cache'),
  plugins: [...(original.plugins ?? []), { name: 'actual-focus-display-source', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    assert.ok(!path.startsWith(resolve(root, 'packages/core/dist') + '/'), 'This source-only fixture must not silently consume Core dist')
    if (!path.startsWith(resolve(root, 'packages/core/src') + '/')) return
    let code = source
    if (path === parser && process.env.AGENTMUX_FOCUS_DISPLAY_MUTATION) {
      assert.equal(process.env.AGENTMUX_FOCUS_DISPLAY_MUTATION, 'direct-request-key')
      assert.equal(source.split(mapping).length - 1, 1, 'Unique actual loaded display/receipt mapping')
      code = source.replace(mapping, 'key as keyof AgentMuxDesktopSpaceSelection')
    }
    if (process.env.AGENTMUX_FOCUS_DISPLAY_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_DISPLAY_LOADED,
      JSON.stringify({ path: relative(root, path), sourceSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(code).digest('hex'), transformed: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { ...original.test, include: ['packages/core/test/control-focus-display.test.ts'], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false,
    globalSetup: [resolve(import.meta.dirname, 'focus-display-demand-freshness.ts')] }
})
