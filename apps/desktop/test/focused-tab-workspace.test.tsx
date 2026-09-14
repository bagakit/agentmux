import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { focusLayoutForTab, tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection.js'

const workbenchSource = readFileSync(new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url), 'utf8')

function tab(id: string, sessionId: string): WorkbenchTab {
  return createWorkbenchTab(id, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId })
}

describe('Focus Tab projection', () => {
  it('resolves the complete durable Tab for the focused session', () => {
    const complete = tab('second', 'session-2')
    complete.regions['second:terminal'] = { regionId: 'second:terminal', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'terminal-2' }
    const original = { first: tab('first', 'session-1'), second: complete }
    const restored = JSON.parse(JSON.stringify(original)) as typeof original
    const selected = tabForFocusedSession(restored, 'session-2')
    expect(selected?.id).toBe('second')
    expect(Object.keys(selected?.regions ?? {})).toEqual(['second:region', 'second:terminal'])
    expect(focusLayoutForTab(selected!).groups[0]?.tabOrder).toEqual(['second'])
    expect(tabForFocusedSession(restored, null)).toBeNull()
  })

  it('keeps the normal interactive Region tree as the only Focus owner', () => {
    expect(workbenchSource).toContain('const bodyTabs =')
    expect(workbenchSource).toContain('{bodyTabs.length > 0 ? bodyTabs.map')
    expect(workbenchSource).toContain('return focusPortalTarget ? createPortal(workbench, focusPortalTarget) : null')
    expect(workbenchSource).toContain('const observer = new MutationObserver(resolveTarget)')
  })
})
