import base from './browser-selection-image-reading.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  uploads: ['apps/desktop/src/renderer/src/components/settings/RetainedBrowserUploads.tsx', 'if (!active) return', '/* visibility guard removed */'],
  shared: ['apps/desktop/src/renderer/src/components/settings/browser-resource-view.ts',
    'const measured = [...counts.keys()].map(key => samples.get(key))',
    'const measured = current.flatMap(row => (row.target.resource?.processes ?? []).map(process => samples.get(processKey(process))))'],
  receipt: ['apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx', 'navigationId: receipt.navigationId, status: receipt.status,', "navigationId: receipt.navigationId, status: 'released',"],
  selection: ['apps/desktop/src/renderer/src/components/settings/BrowserResources.tsx', "perform(selectedRows, 'release')", "perform(shown.filter(row => selected.has(row.target.id)), 'release')"]
} as const
export default { ...base, cacheDir: process.env.AGENTMUX_RESOURCE_CACHE ?? resolve(root, '.tmp/browser-resource-presentation/cache'),
  plugins: [{ name: 'original-resource-presentation-inputs', enforce: 'pre' as const, transform(code: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/desktop\/(?:src|test)\/|packages\/[^/]+\/src\/)/u.test(path)) return
    let served = code
    const mutation = process.env.AGENTMUX_RESOURCE_MUTATION as keyof typeof mutations | undefined
    if (mutation) {
      if (!mutations[mutation]) throw new Error('Unknown resource presentation mutation')
      const [file, from, to] = mutations[mutation]
      if (path === file) {
        if (code.split(from).length !== 2) throw new Error('The selected production target must occur once')
        served = code.replace(from, to)
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_RESOURCE_INPUTS) appendFileSync(process.env.AGENTMUX_RESOURCE_INPUTS,
      JSON.stringify({ path, source: hash(code), served: hash(served), mutated: code !== served }) + '\n')
    return served === code ? undefined : { code: served, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/browser-resource-directory-ui.fixture.tsx'], setupFiles: [], globalSetup: [],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
}
