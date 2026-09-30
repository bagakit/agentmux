import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const pane = resolve(root, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx')
const mutations = {
  'settings-keeps-focus-visible': ['apps/desktop/src/renderer/src/App.tsx', "const focusVisible = mainSurface === 'agents' && !settingsRoute", "const focusVisible = mainSurface === 'agents'"],
  'focus-target-ignores-visible': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '(tabProjection?.surface ? tabProjection.visible === true : true)', 'true']
} as const
export default defineConfig({ ...original, root,
  plugins: [...(original.plugins ?? []), {
    name: 'loaded-browser-settings-source-and-observation', enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(root + '/apps/desktop/src/')) return
      let code = source
      const mutation = process.env.AGENTMUX_BROWSER_SETTINGS_MUTATION as keyof typeof mutations | undefined
      if (mutation) {
        const change = mutations[mutation]
        assert.ok(change, 'Known Browser Settings mutation')
        if (path === resolve(root, change[0])) {
          assert.equal(code.split(change[1]).length - 1, 1, `Unique loaded ${mutation} anchor`)
          code = code.replace(change[1], change[2])
        }
      }
      if (path === pane) {
        const anchor = '  const applyBrowserEvent = useAppStore((state) => state.applyBrowserEvent)'
        assert.equal(code.split(anchor).length - 1, 1)
        code = code.replace(anchor, `  useEffect(() => {
    globalThis.__focusBrowserVisibleCommit?.(tab.browserId, visible)
  }, [tab.browserId, visible])
  useEffect(() => {
    globalThis.__focusBrowserResidency?.(tab.browserId, 'mount')
    return () => globalThis.__focusBrowserResidency?.(tab.browserId, 'unmount')
  }, [])
${anchor}`)
      }
      if (process.env.AGENTMUX_BROWSER_SETTINGS_LOADED) appendFileSync(process.env.AGENTMUX_BROWSER_SETTINGS_LOADED,
        JSON.stringify({ path: relative(root, path), originalSHA256: createHash('sha256').update(source).digest('hex'),
          loadedSHA256: createHash('sha256').update(code).digest('hex'), ...(mutation && path === resolve(root, mutations[mutation][0]) ? { mutation } : {}),
          ...(path === pane ? { observationOnly: true } : {}) }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/focus-browser-settings-visibility-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-browser-settings-visibility.test.tsx'],
    fileParallelism: false, passWithNoTests: false, maxWorkers: 1, testTimeout: 15_000 }
})
