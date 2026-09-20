// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { BrowserSnapshot } from '../src/shared/contracts'
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
const browser: BrowserSnapshot = {
  id: 'native-browser', navigationId: 'native-navigation', profileId: 'profile:default',
  url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', error: null, driving: false, appLinkPrompt: null
}

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

const render = () => dom.render(<SurfaceToolDock surface="workbench" workspace={workspace} />)
function createButton(label: 'New Agent' | 'New Browser') {
  const button = dom.container.querySelector<HTMLButtonElement>(`.surface-tool-activitybar [aria-label="${label}"]`)
  expect(button).not.toBeNull()
  return button!
}
function retainedFacts() {
  const state = useAppStore.getState()
  expect(state.sessions).toEqual([session])
  expect(state.sessions[0]!.control.run).toEqual({ runId: 'run-agent-1' })
  expect(state.tabs[retained.id]).toEqual(retained)
  expect(state.workspaceTool).toBe('browser-tools')
}

describe('Space tool actions on the real dock and Store', () => {
  it('keeps only icon tool selection in Space and preserves the Goals label', async () => {
    await render()
    const header = dom.container.querySelector('.surface-tool-activitybar')!
    expect(header).not.toBeNull()
    const buttons = [...header.querySelectorAll<HTMLButtonElement>('nav button')]
    expect(buttons.map(button => ({
      label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed')
    }))).toEqual([
      { label: 'Files + Branches', pressed: 'false' },
      { label: 'Agents', pressed: 'true' },
      { label: 'Browser Tools', pressed: 'false' }
    ])
    for (const button of buttons) expect(button.title).toContain(`${button.getAttribute('aria-label')} — `)
    expect(header.textContent).toBe('')
    await dom.render(<SurfaceToolDock surface="board" workspace={workspace} />)
    expect(dom.container.querySelector('.surface-tool-activitybar > span')?.textContent).toBe('Branch Board')
    expect(dom.container.querySelector('.surface-tool-create')).toBeNull()
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

  it('opens a Browser through the existing owner without switching tools or replacing the Agent Tab', async () => {
    const create = vi.spyOn(api.browser, 'create').mockResolvedValue(browser)
    await render()
    await dom.click('nav [aria-label="Browser Tools"]')
    expect(dom.container.querySelector('.browser-tools-panel h2')).toBeNull()
    expect(dom.container.querySelector('.browser-tools-panel > .primary-button')).toBeNull()
    expect(dom.container.querySelectorAll('[aria-label="New Browser"]')).toHaveLength(1)
    expect(dom.container.querySelectorAll('.browser-tools-preferences, .browser-profiles, .browser-annotations')).toHaveLength(3)
    await dom.click('.surface-tool-create[aria-label="New Browser"]')
    const state = useAppStore.getState()
    const group = state.layouts[workspace.id]!.groups[0]!
    expect(group.id).toBe('focused-group')
    expect(group.tabOrder).toHaveLength(2)
    expect(group.tabOrder[0]).toBe(retained.id)
    const opened = titleWorkbenchSurface(state.tabs[group.activeTabId!]!)
    expect(opened).toMatchObject({ kind: 'browser', workspaceId: workspace.id, navigationId: 'native-navigation' })
    expect(opened.kind).toBe('browser')
    if (opened.kind !== 'browser') throw new Error('Expected the created Browser surface')
    expect(create).toHaveBeenCalledExactlyOnceWith(opened.regionId, 'about:blank')
    retainedFacts()
    expect(dom.container.querySelector('.surface-tool-error')).toBeNull()
  })

  it('shows pending Browser creation on the single + and ignores repeated clicks', async () => {
    let finish!: (value: BrowserSnapshot) => void
    const create = vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    useAppStore.setState({ workspaceTool: 'browser-tools' })
    await render()
    await dom.click('.surface-tool-create[aria-label="New Browser"]')
    const pending = createButton('New Browser')
    expect(pending.disabled).toBe(true)
    expect(pending.title).toBe('Opening Browser…')
    expect(pending.querySelector('.spin')).not.toBeNull()
    await dom.click('.surface-tool-create[aria-label="New Browser"]')
    expect(create).toHaveBeenCalledTimes(1)
    retainedFacts()
    await act(async () => finish(browser))
    expect(createButton('New Browser').disabled).toBe(false)
    expect(createButton('New Browser').querySelector('.spin')).toBeNull()
  })

  it('keeps Browser failures in the existing error surface and leaves the live Agent intact', async () => {
    const create = vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Browser creation failed'))
    useAppStore.setState({ workspaceTool: 'browser-tools' })
    await render()
    await dom.click('.surface-tool-create[aria-label="New Browser"]')
    expect(create).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('.surface-tool-error[role="alert"]')?.textContent).toBe('Browser creation failed')
    expect(createButton('New Browser').disabled).toBe(false)
    retainedFacts()
  })

  it('reports unavailable Browser focus instead of silently ignoring +', async () => {
    const create = vi.spyOn(api.browser, 'create')
    useAppStore.setState({ workspaceTool: 'browser-tools', layouts: {} })
    await render()
    await dom.click('.surface-tool-create[aria-label="New Browser"]')
    expect(create).not.toHaveBeenCalled()
    expect(dom.container.querySelector('.surface-tool-error[role="alert"]')?.textContent)
      .toBe('Select a workspace and focus a pane before opening a browser.')
    retainedFacts()
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
