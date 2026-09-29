import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const rootUrl = new URL('../../../../../', import.meta.url)
const root = fileURLToPath(rootUrl)
const changes = {
  'split-region-steals-selection': ['apps/desktop/src/renderer/src/lib/control.ts',
    'activeRegionId: tab.layout.activeRegionId', 'activeRegionId: regionId'],
  'split-tab-steals-selection': ['apps/desktop/src/renderer/src/lib/control.ts',
    "? layout\n      : activateTab", '? activateTab(layout, findGroupForTab(layout, tab.id)!.id, tab.id)\n      : activateTab'],
  'new-tab-steals-selection': ['apps/desktop/src/renderer/src/lib/control.ts',
    'activeTabId: anchorGroup.activeTabId, recentTabIds: anchorGroup.recentTabIds',
    'activeTabId: tab.id, recentTabIds: anchorGroup.recentTabIds'],
  'new-tab-steals-group': ['apps/desktop/src/renderer/src/lib/control.ts',
    'activeGroupId: layout.activeGroupId,', 'activeGroupId: anchorGroup.id,'],
  'open-steals-main-surface': ['apps/desktop/src/renderer/src/store.ts',
    '    set({ tabs: plan.tabs, layouts: plan.layouts })',
    "    set({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })"],
  'late-create-steals-caret': ['apps/desktop/src/renderer/src/store.ts',
    'return { tabs: { ...current.tabs, [owner.tab.id]: updateWorkbenchRegion(owner.tab, plan.regionId, () => surface) } }',
    'return { regionCaretFocus: { regionId: plan.regionId, nonce: 999 }, tabs: { ...current.tabs, [owner.tab.id]: updateWorkbenchRegion(owner.tab, plan.regionId, () => surface) } }'],
  'completion-steals-region': ['apps/desktop/src/renderer/src/store.ts',
    'updateWorkbenchRegion(owner.tab, plan.regionId, () => surface)',
    'replaceWorkbenchRegion(owner.tab, plan.regionId, surface)'],
  'rollback-selects-unchanged-launcher': ['apps/desktop/src/renderer/src/lib/control.ts',
    "  if (plan.kind === 'launcher' && expectedSurface === plan.launcher) return null", '  // Mutation: reselect the unchanged original Launcher.'],
  'unknown-run-deletes-original': ['apps/desktop/src/renderer/src/store.ts',
    "    if (request.operation === 'browser.run') {", "    if (request.operation === 'browser.run') {\n      set({ tabs: {}, layouts: {} })"],
  'guide-allows-gui-fallback': ['packages/core/src/agentmux-cli-help.ts',
    'or use GUI input to get around that result.', 'and use GUI input to get around that result.'],
  'pending-launcher-steals-input': ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
    'autoFocus={visible && presentationActive && inputRegionActive && !controlNavigation}',
    'autoFocus={visible && presentationActive && !controlNavigation}'],
  'pending-launcher-starts-warm-runtime': ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
    "if (workspace && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === 'expanded')",
    "if (workspace && visible && presentationActive && !controlNavigation && sections.terminal === 'expanded')"],
  'pending-launcher-starts-detection': ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
    'if (!visible || !presentationActive || !inputRegionActive || controlNavigation) return',
    'if (!visible || !presentationActive || controlNavigation) return'],
  'cli-browser-op-misdirected': ['packages/core/src/agentmux.ts',
    ": await requestAgentMuxControl({ ...requestBase(), operation: 'open.browser',",
    ": await requestAgentMuxControl({ ...requestBase(), operation: 'open.terminal',"]
} as const

export default defineConfig({
  root,
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) }] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'browser-nonactivating-actual-source', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(root)) return
    const rel = relative(root, path)
    const key = process.env.AGENTMUX_BROWSER_NONACTIVATING_MUTATION as keyof typeof changes | undefined
    let code = source
    if (key) {
      assert.ok(changes[key], 'Known actual Source mutation')
      const [file, from, to] = changes[key]
      if (rel === file) {
        assert.equal(code.split(from).length - 1, 1, `Unique ${key} loaded Source block`)
        code = code.replace(from, to)
      }
    }
    if (process.env.AGENTMUX_BROWSER_NONACTIVATING_LOADED && /^(apps\/desktop\/src|packages\/(core|layout)\/src)\//.test(rel) && /\.(?:tsx?|[cm]ts)$/.test(rel)) {
      appendFileSync(process.env.AGENTMUX_BROWSER_NONACTIVATING_LOADED, JSON.stringify({ path: rel,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(code).digest('hex'),
        ...(key && rel === changes[key][0] ? { mutation: key } : {}) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: {
    include: ['apps/desktop/test/browser-nonactivating-cli.test.ts', 'apps/desktop/test/view-focus.test.ts'],
    maxWorkers: 1, cache: false, passWithNoTests: false, testTimeout: 15_000, hookTimeout: 30_000,
    setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))]
  }
})
