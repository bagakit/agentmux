import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(process.env.AGENTMUX_SETTINGS_PARENT_EVIDENCE ?? resolve(root, '.bagakit/design/settings-followups-20261004/parent-cost-evidence/direct'))
const mutant = process.env.AGENTMUX_SETTINGS_PARENT_MUTANT ?? 'baseline'
assert.ok(['baseline', 'memo-removed', 'callback-unstable', 'frozen-props'].includes(mutant), '已知且唯一的私有变异')
const productPaths = [
  'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
  'apps/desktop/src/renderer/src/components/SettingsNavigation.tsx',
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/agents.tsx',
  'apps/desktop/src/renderer/src/components/settings/use-resource-drafts.ts',
  'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/main/config-owner.ts',
  'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/runtime-config-transaction.ts'
]
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
mkdirSync(evidence, { recursive: true })
const expected = new Map(productPaths.map(path => [path, sha(readFileSync(resolve(root, path)))]))
writeFileSync(resolve(evidence, 'source-inputs.json'), JSON.stringify(Object.fromEntries(expected), null, 2) + '\n')
function replaceOne(code: string, anchor: string, replacement: string): string {
  assert.equal(code.split(anchor).length - 1, 1, `唯一非空 Source observation/mutation anchor: ${anchor}`)
  return code.replace(anchor, replacement)
}
function profiler(code: string, opening: string, id: string): string {
  code = replaceOne(code, opening, opening.replace('  return (\n', `  return (\n    <SourceSettingsProfiler id="${id}" onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) =>\n      globalThis.__settingsParentRecord?.('commit', id, { phase, actualDuration, baseDuration, startTime, commitTime })}>\n`))
  code = replaceOne(code, '    </div>\n  )\n}', '    </div>\n    </SourceSettingsProfiler>\n  )\n}')
  return `import { Profiler as SourceSettingsProfiler } from 'react'\n${code}`
}
function observedCallback(value: string, caller: string): string {
  // Observe the actual JSX prop and return the original function reference unchanged.
  return `((fn) => { globalThis.__settingsParentRecord?.('caller', '${caller}', { onClose: fn }); return fn })(${value})`
}
export default defineConfig({
  ...original, root, esbuild: { jsx: 'automatic' }, cacheDir: resolve(evidence, 'cache'),
  plugins: [{ name: 'settings-parent-owning-source-observation', enforce: 'pre',
    transform(source, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!(path.startsWith('apps/desktop/src/') || path.startsWith('packages/')) || !/\.[cm]?[jt]sx?$/u.test(path)) return
      if (expected.has(path)) assert.equal(sha(source), expected.get(path), `原输入身份改变: ${path}`)
      let code = source
      if (path.endsWith('/renderer/src/App.tsx')) {
        code = replaceOne(code, 'function DesktopApp() {\n', "function DesktopApp() {\n  globalThis.__settingsParentRecord?.('render', 'DesktopApp')\n")
        const callback = mutant === 'callback-unstable' ? '() => setSettingsRoute(null)' : 'closeSettings'
        code = replaceOne(code, 'onClose={closeSettings}', `onClose={${observedCallback(callback, 'SettingsPanel')}}`)
        code = replaceOne(code, 'onCloseSettings={closeSettings}', `onCloseSettings={${observedCallback('closeSettings', 'SurfaceSwitch')}}`)
      }
      if (path.endsWith('/components/SettingsPanel.tsx')) {
        code = replaceOne(code, '  const config = useAppStore((state) => state.config)',
          "  globalThis.__settingsParentRecord?.('render', 'SettingsPanel', { initialSection, executorId })\n  const config = useAppStore((state) => state.config)")
        code = profiler(code, '  return (\n    <div className="settings-page"', 'SettingsPanel')
        if (mutant === 'memo-removed') code = replaceOne(code, 'export const SettingsPanel = memo(SettingsPanelView)', 'export const SettingsPanel = SettingsPanelView')
        if (mutant === 'frozen-props') code = replaceOne(code, 'export const SettingsPanel = memo(SettingsPanelView)', 'export const SettingsPanel = memo(SettingsPanelView, () => true)')
      }
      if (path.endsWith('/settings/HostSettingsPane.tsx')) {
        code = replaceOne(code, '  const resource = useResourceDrafts(', "  globalThis.__settingsParentRecord?.('render', 'HostSettingsPane')\n  const resource = useResourceDrafts(")
        code = replaceOne(code, '  // The keyed Host card owns this component', "  globalThis.__settingsParentRecord?.('render', 'HostConnectionFields', { hostId: host.id })\n  // The keyed Host card owns this component")
        code = replaceOne(code, 'sessions.filter((session) => session.hostId === host.id)',
          'sessions.filter((session) => { globalThis.__settingsParentVisit?.(host.id); return session.hostId === host.id })')
        code = profiler(code, '  return (\n    <div className="settings-pane-stack"', 'HostSettingsPane')
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(readFileSync(resolve(root, path))),
        transformInputSHA256: sha(source), moduleId: id, consumedSHA256: sha(code), bytes: Buffer.byteLength(code), mutant,
        observationOnly: mutant === 'baseline' || !['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'].includes(path) }) + '\n')
      if (code !== source) {
        const snapshot = resolve(evidence, 'consumed', path)
        mkdirSync(dirname(snapshot), { recursive: true }); writeFileSync(snapshot, code)
        return { code, map: null }
      }
    }
  }],
  test: { ...original.test, include: [
    'apps/desktop/test/settings-parent-cost.test.tsx', 'apps/desktop/test/settings-search.test.ts',
    'apps/desktop/test/settings-draft-conflict.test.tsx', 'apps/desktop/test/settings-keyboard-shortcuts.test.tsx',
    'apps/desktop/test/settings-prompts-liquid.test.tsx', 'apps/desktop/test/settings-workbench.test.tsx',
    'apps/desktop/test/settings-overview.test.tsx', 'apps/desktop/test/app-smoke-workspace-selection.test.tsx'
  ], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
