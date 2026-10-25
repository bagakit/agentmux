import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import base from './performance-workbench.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const host = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports as Record<string, { import: string }>
const aliases = Object.entries(host).map(([key, value]) => ({
  find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)),
  replacement: resolve(root, 'apps/host/src', value.import.slice(7).replace(/\.js$/u, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
const mutations = {
  'automatic-cleanup': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    "    void run('inspect')\n", "    void run('reclaim')\n"],
  'entry-read': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    "    void run('inspect')\n", "    /* entry read omitted */\n"],
  'overwrite-cleanup': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    "if (action === 'reclaim') setCleanup({ kind: 'receipt', result: receipt })", "setCleanup({ kind: 'receipt', result: receipt })"],
  'delta-sign': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    '? after - before : null', '? before - after : null'],
  'lossless-browser': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    'working.current = true; inspected.current = targetKey; setPending(action)',
    "working.current = true; inspected.current = targetKey; setPending(action); if (action === 'reclaim') for (const row of directory.rows) void api.browser.release(row.target.id, row.target.navigationId!)"],
  'hidden-reader': ['apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
    'useBrowserDirectory(active)', 'useBrowserDirectory(true)'],
  'batch-receipt': ['apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx',
    'navigationId: receipt.navigationId, status: receipt.status,', "navigationId: receipt.navigationId, status: 'released',"],
  'filtered-batch': ['apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx',
    "perform(selectedRows, 'release')", "perform(shown.filter(row => selected.has(row.target.id)), 'release')"],
  'shared-memory': ['apps/desktop/src/renderer/src/lib/browser-resource-view.ts',
    'const measured = [...counts.keys()].map(key => samples.get(key))',
    'const measured = current.flatMap(row => (row.target.resource?.processes ?? []).map(process => samples.get(processKey(process))))']
} as const
export default { ...base, cacheDir: resolve(root, '.tmp/performance-reclaim/cache'),
  resolve: { ...base.resolve, alias: [...aliases, ...base.resolve!.alias as []] },
  plugins: [{ name: 'performance-reclaim-source', enforce: 'pre' as const, transform(code: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|host)\/(?:src|test)\/|packages\/[^/]+\/src\/)/u.test(path) || !/\.(?:ts|tsx|js|mjs|css)$/u.test(path)) return
    let served = code
    const mutation = process.env.AGENTMUX_RECLAIM_MUTATION as keyof typeof mutations | undefined
    if (mutation) {
      if (!mutations[mutation]) throw new Error('Unknown reclaim mutation')
      const [file, before, after] = mutations[mutation]
      if (path === file) {
        if (code.split(before).length !== 2) throw new Error('The original source mutation must match once')
        served = code.replace(before, after)
      }
    }
    if (process.env.AGENTMUX_RECLAIM_INPUTS) {
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      appendFileSync(process.env.AGENTMUX_RECLAIM_INPUTS, JSON.stringify({ path, source: hash(code), served: hash(served), mutated: served !== code }) + '\n')
    }
    return served === code ? undefined : { code: served, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/performance-reclaim.test.tsx', 'apps/desktop/test/performance-workbench.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
}
