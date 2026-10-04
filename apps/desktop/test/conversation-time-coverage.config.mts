import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alias = ['core', 'client-ui'].flatMap(pkg => Object.entries(JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8')).exports).sort(([a], [b]) => b.replace('*','').length-a.replace('*','').length).flatMap(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser?: string; import: string }).browser ?? (value as { import: string }).import
  const name = '@agentmux/' + pkg + (key === '.' ? '' : key.slice(1))
  return [{ find: new RegExp('^' + name.split('*').map(escape).join('(.*)') + '$'), replacement: resolve(root, `packages/${pkg}`, target.replace('*', '$1')) }]
}))
const windowPath = 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts'
const mutations: Record<string, [string, string, string]> = {
  'stop-coverage': [windowPath, "void read('coverage')", 'coverageDemand.current = false'],
  'hide-first-page': [windowPath, 'update({ key: start.key, window: prefix, loading: true, error: null })', 'void prefix'],
  'mutate-accepted-prefix': [windowPath, 'assemble([...parts], [...positions], head,', 'assemble(parts, positions, head,'],
  'drop-generation-fence': [windowPath, 'generation.current === attempt && live.current.key', 'live.current.key'],
  'ignore-record-budget': [windowPath, "if (direction === 'coverage' && retainedCount >= RECORD_COUNT)", 'if (false)'],
  'ignore-remaining-slots': [windowPath, "Math.min(PAGE_LIMIT, RECORD_COUNT - retainedCount)", 'PAGE_LIMIT'],
  'swallow-untimed-retry': [windowPath, '!(retryPage && i === 0) && !needsTimeCoverage', '!needsTimeCoverage'],
  'disconnect-range-selector': ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'nativeContextItems, RULER_WINDOWS[rulerWindow])', 'nativeContextItems, 24 * 3_600_000)']
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.local/time-coverage-cache'), resolve: { alias, conditions: ['browser'] },
  plugins: [{ name: 'actual-time-window-inputs', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(root + '/apps/desktop/src/') && !path.startsWith(root + '/packages/')) return
    const relativePath = relative(root, path), name = process.env.TIME_COVERAGE_MUTATION
    let code = source
    if (name) {
      const change = mutations[name]; assert.ok(change, 'Known actual mutation')
      if (relativePath === change[0]) { assert.equal(source.split(change[1]).length-1,1,'Unique actual source target'); code = source.replace(change[1],change[2]) }
    }
    if (process.env.TIME_COVERAGE_LOADED) appendFileSync(process.env.TIME_COVERAGE_LOADED, JSON.stringify({path: relativePath, sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(code).digest('hex'), transformed: source !== code, mutation: name})+'\n')
    if (code !== source) return {code, map:null}
  } }],
  test: { include: ['apps/desktop/test/conversation-time-coverage.test.tsx','apps/desktop/test/conversation-ruler-windows.test.ts'], environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
