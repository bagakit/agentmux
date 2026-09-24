// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, titleWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const session = composerSession()
const retained = createWorkbenchTab('retained-agent-tab', {
  regionId: 'retained-region', kind: 'agent', phase: 'attached',
  workspaceId: workspace.id, sessionId: session.id
})

beforeEach(() => {
  useAppStore.setState({
    config: composerConfig, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    workspaceTool: 'agents', projectRailOpen: true, sessions: [session],
    tabs: { [retained.id]: retained },
    layouts: { [workspace.id]: createWorkspaceLayout('focused-group', [retained.id]) },
    browserAnnotationsByBrowserId: {}, explorerCollapsed: {}, demands: {},
    agentNames: {}, displacedAgentSessionIds: [], error: null
  })
})

const render = () => dom.render(<SurfaceToolDock workspace={workspace} />)
function createButton(label: 'New Agent') {
  const button = dom.container.querySelector<HTMLButtonElement>(`.surface-tool-activitybar [aria-label="${label}"]`)
  expect(button).not.toBeNull()
  return button!
}

describe('Space tool actions on the real dock and Store', () => {
  it('keeps only icon tool selection in Space', async () => {
    await render()
    const header = dom.container.querySelector('.surface-tool-activitybar')!
    expect(header).not.toBeNull()
    const buttons = [...header.querySelectorAll<HTMLButtonElement>('nav button')]
    expect(buttons.map(button => ({
      label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed')
    }))).toEqual([
      { label: 'Files + Branches', pressed: 'false' },
      { label: 'Agents', pressed: 'true' }
    ])
    for (const button of buttons) expect(button.title).toContain(`${button.getAttribute('aria-label')} — `)
    expect(header.textContent).toBe('')

  })

  it('opens the existing Launcher owner in the focused group and retains the live Agent', async () => {
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    await render()
    expect(createButton('New Agent').title).toContain('choose an Executor')
    await dom.click('.surface-tool-create[aria-label="New Agent"]')
    const state = useAppStore.getState()
    const group = state.layouts[workspace.id]!.groups[0]!
    expect(group.id).toBe('focused-group')
    expect(group.tabOrder).toHaveLength(2)
    expect(group.tabOrder[0]).toBe(retained.id)
    expect(group.activeTabId).toBe(group.tabOrder[1])
    expect(titleWorkbenchSurface(state.tabs[group.activeTabId!]!)).toMatchObject({
      kind: 'launcher', workspaceId: workspace.id
    })
    expect(state.tabs[retained.id]).toEqual(retained)
    expect(state.sessions).toEqual([session])
    expect(state.sessions[0]!.control.run).toEqual({ runId: 'run-agent-1' })
    expect(state.workspaceTool).toBe('agents')
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not expose a no-op Agent creation action before the layout is restored', async () => {
    useAppStore.setState({ layouts: {} })
    await render()
    expect(dom.container.querySelector('[aria-label="New Agent"]')).toBeNull()
    expect(useAppStore.getState().tabs[retained.id]).toEqual(retained)
    expect(useAppStore.getState().sessions).toEqual([session])
  })

  it('does not leave a second Browser management or creation entry in Space', async () => {
    await render()
    expect(dom.container.querySelector('[aria-label="Browser Tools"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="New Browser"]')).toBeNull()
    expect(dom.container.querySelector('.browser-tools-panel')).toBeNull()
    expect(useAppStore.getState().tabs[retained.id]).toEqual(retained)
    expect(useAppStore.getState().sessions).toEqual([session])
  })

  it('keeps the original FileExplorer creation and refresh controls without a second +', async () => {
    useAppStore.setState({ workspaceTool: 'files-branches' })
    await render()
    expect(dom.container.querySelector('.surface-tool-create')).toBeNull()
    expect([...dom.container.querySelectorAll<HTMLButtonElement>('.explorer-header__actions button')]
      .map(button => button.title)).toEqual(['New file', 'New folder', 'Refresh explorer'])
    expect(dom.container.querySelector('.workspace-tool-context > span')?.getAttribute('title')).toBe(workspace.path)
    expect(dom.container.querySelector('.workspace-tool-context small')).toBeNull()
    expect(useAppStore.getState().tabs[retained.id]).toEqual(retained)
    expect(useAppStore.getState().sessions).toEqual([session])
  })
})
