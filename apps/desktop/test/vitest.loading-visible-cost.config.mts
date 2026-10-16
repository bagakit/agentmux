import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owners = ['FullPageLoadingSurface', 'TerminalView', 'SessionConnectingSurface', 'EditorPane'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const snapshots: Record<string, string> = process.env.AGENTMUX_LOADING_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_LOADING_SOURCES, 'utf8')) : {}
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/loading-visible-cost-vitest-cache'),
  plugins: [{ name: 'actual-loading-presentation-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!owners.includes(path)) return
    let code = snapshots[path] ?? original
    const effective = code, mutant = process.env.AGENTMUX_LOADING_MUTANT
    const changes: Record<string, [string, string, string, number]> = {
      'hidden-styles': [owners[0]!, '!visible || !inView || document.hidden', '!inView || document.hidden', 1],
      'reset-elapsed': [owners[0]!, 'useEffect(() => {\n    let inView = true', 'useEffect(() => {\n    const startedAt = Date.now()\n    let inView = true', 1],
      'connecting-visible': [owners[2]!, '    visible={visible}\n', '', 1],
      'editor-visible': [owners[3]!, 'phase="loading" visible={visible}', 'phase="loading"', 2],
      'terminal-visible': [owners[1]!, '              visible={visible}\n', '', 2]
    }
    if (mutant) {
      assert(changes[mutant], 'Known loading owner inverse')
      const [file, before, after, count] = changes[mutant]!
      if (path === file) {
        assert.equal(code.split(before).length - 1, count, 'Exact loaded presentation owner inverse')
        code = code.replaceAll(before, after); process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
      }
    }
    if (process.env.AGENTMUX_LOADING_LOADED) appendFileSync(process.env.AGENTMUX_LOADING_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_LOADING_TERMINAL
    ? ['apps/desktop/test/terminal-webgl-visibility.test.tsx']
    : ['apps/desktop/test/loading-visible-consumers.test.tsx', ...(process.env.AGENTMUX_LOADING_PREFLIGHT ? [] : ['apps/desktop/test/full-page-loading-wait.test.tsx'])],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
