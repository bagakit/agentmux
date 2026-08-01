import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const policy = readFileSync(
  new URL('../src/renderer/src/lib/surface-memory-budget.ts', import.meta.url),
  'utf8'
)
const coordinator = readFileSync(
  new URL('../src/renderer/src/lib/surface-memory-budget-coordinator.tsx', import.meta.url),
  'utf8'
)
const candidates = readFileSync(
  new URL('../src/renderer/src/lib/surface-memory-budget-candidates.ts', import.meta.url),
  'utf8'
)
const navigation = readFileSync(
  new URL('../src/renderer/src/lib/surface-navigation-visibility.ts', import.meta.url),
  'utf8'
)
const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const workbench = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const editor = readFileSync(
  new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url),
  'utf8'
)
const browser = readFileSync(
  new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
  'utf8'
)
const manager = readFileSync(new URL('../src/main/browser-view-manager.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8')

describe('Browser/Monaco surface budget wiring', () => {
  it('scans non-empty policy and production sources', () => {
    expect(policy.length).toBeGreaterThan(5_000)
    expect(coordinator.length).toBeGreaterThan(7_000)
    // 在屏判定被抽到 surface-navigation-visibility 之后，这个数按**两个文件之和**判：那次抽取把
    // 约 1.4KB 从候选收集器搬到了兄弟文件里，字节并没有消失。只把地板调低会让这道自检对
    // 「候选收集器被整段掏空、逻辑没搬到任何地方」重新失明——它守的本来就是「扫到的不是空文件」。
    expect(candidates.length + navigation.length).toBeGreaterThan(4_000)
    expect(workbench.length).toBeGreaterThan(10_000)
  })

  it('keeps Browser and Monaco budgets independent from Terminal parking', () => {
    expect(policy).not.toContain('terminal-cold-parking')
    expect(policy).toContain("SurfaceMemoryKind = 'monaco' | 'browser'")
    expect(policy).toContain('selectBrowserSurfaceReleases')
    expect(policy).toContain('selectMonacoSurfaceReleases')
    expect(coordinator).toContain('selectSurfaceMemoryReleases')
    expect(coordinator).toContain('collectSurfaceMemoryCandidates')
    expect(candidates).toContain('export function collectSurfaceMemoryCandidates')
    expect(coordinator).not.toContain('selectColdParkedTerminalRegions')
  })

  it('has production callers for coordinator, Browser release/restore, and Monaco release state', () => {
    expect(app).toContain('useSurfaceMemoryBudget(')
    expect(app).toContain('<SurfaceMemoryBudgetProvider')
    expect(workbench).toContain('useBrowserSurfaceReleased')
    expect(workbench).toContain('useMonacoSurfaceReleased')
    expect(workbench).toContain('released={browserReleased}')
    expect(workbench).toContain('released={monacoReleased}')
    expect(browser).toContain('api.browser.release')
    expect(browser).toContain('api.browser.restore')
    expect(editor).toContain('EditorReleasedState')
    expect(editor).toContain('released = false')
  })

  it('keeps Browser native release on the Main boundary and retains the Region projection', () => {
    expect(manager).toContain('releasedEntries')
    expect(manager).toContain('async release(id: string)')
    expect(manager).toContain('async restore(id: string')
    expect(manager).toContain("this.send({ type: 'closed', id })")
    expect(ipc).toContain("handle('browser:release'")
    expect(ipc).toContain("handle('browser:restore'")
    expect(preload).toContain("ipcRenderer.invoke('browser:release'")
    expect(preload).toContain("ipcRenderer.invoke('browser:restore'")
    expect(contracts).toContain('release(id: string): Promise<void>')
    expect(contracts).toContain('restore(id: string, input:')
  })

  it('retains document and Browser identity facts as rebuild inputs', () => {
    expect(candidates).toContain('documentPresent')
    expect(candidates).toContain('dirtyDocuments')
    expect(candidates).toContain('surface.profileId')
    expect(candidates).toContain('surface.viewport')
    expect(browser).toContain('navigationId')
    expect(browser).toContain('applyBrowserEvent({ type: \'updated\', browser })')
    expect(browser).toContain('if (released) return')
    expect(browser).not.toContain('url: tab.url')
    expect(editor).toContain('document.content')
    expect(editor).toContain('editor.onDidDispose')
  })
})
