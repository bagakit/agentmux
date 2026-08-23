import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

const app = readFileSync(
  new URL('../src/renderer/src/App.tsx', import.meta.url),
  'utf8'
)
const workbench = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const newTab = readFileSync(
  new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
  'utf8'
)
const styles = allStyles()

describe('window-owned Workspace Workbench registry', () => {
  it('mounts the active and previously populated Workspaces instead of routing only the active one', () => {
    expect(app).toContain('const mountedWorkspaces = config?.workspaces.filter')
    expect(app).toContain('layouts[candidate.id]?.groups.some((group) => group.tabOrder.length > 0)')
    expect(app).toContain('{mountedWorkspaces.map((candidate) =>')
    // Scratch owns real Topic Tabs/Regions. Filtering its stable id leaves the right workbench
    // surface empty after openScratchTopic has already selected it.
    expect(app).not.toContain("candidate.id !== '__scratch__'")
    // A conditional active-only render is the exact regression that destroys xterm attachments.
    expect(app).not.toContain('<WorkspaceWorkbench\n                        workspaceId={workspace.id}')
  })

  it('parks inactive slots without unmounting their subtree', () => {
    expect(app).toContain('className={`workspace-workbench-slot ${visible ? \'\' : \'workspace-workbench-slot--parked\'}`')
    expect(app).toContain('inert={!visible}')
    const slotMatch = styles.match(/\.workspace-workbench-slot\s*\{([^}]*)\}/)
    expect(slotMatch).not.toBeNull()
    const slot = slotMatch?.[1] ?? ''
    expect(slot).toContain('position: absolute')
    expect(slot).toContain('visibility: hidden')
    expect(slot).toContain('pointer-events: none')
    expect(slot).not.toContain('display: none')
  })

  it('keeps only the active Workbench native surfaces live', () => {
    expect(workbench).toContain('visible?: boolean')
    expect(workbench).toContain('nativeSurfacesVisible={visible && activeDrag === null && !tabMenuOpen}')
    expect(app).toContain('visible={visible}')
  })

  it('does not prewarm a hidden launcher for every parked Workspace', () => {
    expect(workbench).toContain('visible={nativeSurfacesVisible}')
    expect(newTab).toContain('visible = true')
    // prewarm 的极性（只在 visible 时预热，且调用点恰好一处）由 new-tab-prewarm-visible-only.test.ts
    // 用 AST 数出口守住。此前这里是一条 `toContain('if (workspace && visible) prewarmTerminal(...)')`
    // 文本断言——实测可绕过：保留那行不动、在它上面加一行 `if (workspace) prewarmTerminal(...)`，
    // 每个泊车 workspace 都会抢那唯一的热终端槽，而此文件照旧全绿。字面量在场 ≠ 语义正确。
    //
    // 依赖数组的内容同样不在这里抄：抄整个字面量会让每次合法增删依赖都打红这一条（实测 #308 就
    // 撞上了），而它并不比 AST 判据更强。warm-terminal-ownership.test.ts 的接线层守「visible 与
    // warmSlotHeld 在依赖里、带归属的 warmSession/warmPending 不在」，那才是承重的性质。
    // DOM behavior (hidden → visible → hidden) is covered by composer-input-ownership.
    expect(newTab).toContain('autoFocus={visible}')
    expect(newTab).toContain('if (!visible) return')
    expect(newTab).toContain('visible={visible}')
  })

  it('does not use a second terminal cache or remount key for parked Workbenches', () => {
    expect(app + workbench).not.toMatch(/(terminal|workbench)[A-Za-z]*Pool|parkedTerminals|instancePool/)
    expect(app).toContain('key={candidate.id}')
  })

  it('keeps the registry mounted while Settings is open', () => {
    expect(app).toContain('inert={Boolean(settingsRoute)}')
    expect(app).toContain("const workbenchVisible = mainSurface === 'workbench' && !settingsRoute")
    expect(app).toContain('const visible = workbenchVisible && candidate.id === activeWorkspaceId')
    expect(app).toContain('{settingsRoute ? (')
    expect(app).not.toContain('if (settingsRoute) return (')
  })
})
