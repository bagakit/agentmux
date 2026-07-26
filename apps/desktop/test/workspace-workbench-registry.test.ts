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
  it('mounts every Workspace with an existing layout instead of routing only the active one', () => {
    expect(app).toContain('const mountedWorkspaces = config?.workspaces.filter')
    expect(app).toContain('layouts[candidate.id]?.groups.some((group) => group.tabOrder.length > 0)')
    expect(app).toContain('{mountedWorkspaces.map((candidate) =>')
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
    expect(newTab).toContain('if (workspace && visible) prewarmTerminal(workspace.id)')
    expect(newTab).toContain('[prewarmTerminal, visible, workspace?.id]')
    expect(newTab).toContain('if (visible) promptRef.current?.focus()')
    expect(newTab).toContain('if (!visible) return')
    expect(newTab).toContain('visible={visible}')
  })

  it('does not use a second terminal cache or remount key for parked Workbenches', () => {
    expect(app + workbench).not.toMatch(/(terminal|workbench)[A-Za-z]*Pool|parkedTerminals|instancePool/)
    expect(app).toContain('key={candidate.id}')
  })
})
