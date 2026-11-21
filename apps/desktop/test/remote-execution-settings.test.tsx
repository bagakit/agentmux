// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentExecutionInspection } from '@agentmux/core'
import { AGENT_EXECUTION_GUIDE } from '@agentmux/core/agent-execution-guide'
import type { AppConfig } from '../src/shared/contracts'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { remoteExecutionSettingsModule } from '../src/renderer/src/components/settings/modules/remote-execution'
import { settingsNavGroups, visibleSettingsSections } from '../src/renderer/src/components/settings/settings-modules'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { DocumentationTestOwner } from './helpers/documentation-owner'

const dom = composerDOM()
let config: AppConfig
const close = vi.fn()
const one = { ...composerSession('original-one'), workPlacement: { agentHostId: 'local', resourceHostId: 'remote' }, toolExecution: { bindingId: 'binding-one', resourceHostId: 'remote', workspacePath: '/same/project' } }
const two = { ...composerSession('original-two'), hostId: 'remote', control: { ...composerSession('original-two').control, hostId: 'remote' }, workPlacement: { agentHostId: 'remote', resourceHostId: 'local' }, toolExecution: { bindingId: 'binding-two', resourceHostId: 'local', workspacePath: '/same/project' } }
function fact(session = one): AgentExecutionInspection {
  return { bindingId: session.toolExecution.bindingId, agentSessionId: session.control.agentSessionId, agentHostId: session.control.hostId,
    resourceHostId: session.toolExecution.resourceHostId, resourceWorkspacePath: session.toolExecution.workspacePath, state: 'connected' }
}
beforeEach(async () => {
  close.mockClear()
  config = { ...await api.config.get(), hosts: [{ id: 'local', kind: 'local', label: 'Same host label' },
    { id: 'remote', kind: 'ssh', label: 'Same host label', hostname: 'controlled.invalid' }],
    workspaces: [{ id: 'project-local', hostId: 'local', name: 'Same project', path: '/same/project', kind: 'folder' },
      { id: 'project-remote', hostId: 'remote', name: 'Same project', path: '/same/project', kind: 'folder' },
      { id: '__scratch__', hostId: 'local', name: 'Scratch', path: '/scratch', kind: 'folder' }] }
  useAppStore.setState({ config, sessions: [one, two, composerSession('ordinary')], activeWorkspaceId: 'project-local', tabs: {},
    layouts: { 'project-local': createWorkspaceLayout('group-local'), 'project-remote': createWorkspaceLayout('group-remote') },
    agentComposerDrafts: { retained: 'Do not change this authored draft' }, spaceZoneBindings: {}, workbenchSpaceSelection: null })
})
async function pane(active = true) {
  const Pane = remoteExecutionSettingsModule.Pane
  await dom.render(<DocumentationTestOwner><Pane config={config} active={active} onClose={close} onNavigate={() => {}} /></DocumentationTestOwner>)
}
async function selectWork(selector: string) {
  const tab = dom.container.querySelector<HTMLButtonElement>('.remote-work-tasks [role=tab][aria-controls$="-existing"]')!
  await act(async () => tab.click())
  const row = dom.container.querySelector<HTMLElement>(selector)!
  expect(row.closest('[hidden],[inert]')).toBeNull()
  await dom.click(selector)
}
async function button(text: string) {
  const candidates = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === text)
  expect(candidates, `exact visible action ${text}`).toHaveLength(1)
  await act(async () => candidates[0]!.click())
}
async function chooseField(label: string, value: string) {
  const trigger = dom.container.querySelector<HTMLButtonElement>(`button.selection-field[aria-label="${label}"]`)!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const item = document.querySelector<HTMLElement>(`[role=menuitemradio][data-value="${value}"]`)
  expect(item).not.toBeNull(); await act(async () => item!.click())
}
const chooseProject = (id: string) => chooseField('Working folder for this arrangement', id)
async function startPreparation() {
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.remote-work-tasks [role=tab][aria-controls$="-start"]')!.click())
}
function guideText(content: string) {
  return content.replace(/^```[^\n]*$/gmu, '').replace(/^#{1,6} /gmu, '').replace(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gmu, '').replace(/\|/gu, '').replace(/^\d+\. /gmu, '').replace(/^\s*- /gmu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/\*\*|`/gu, '').replace(/\s+/gu, '')
}

describe('Remote execution Settings', () => {
  it('keeps the authoritative empty list compact without a second empty reader', async () => {
    useAppStore.setState({ sessions: [] })
    await pane()
    expect(dom.container.textContent?.match(/No remote work is visible here yet/gu)).toHaveLength(1)
    expect(dom.container.querySelector('.remote-execution-bindings__body')).toBeNull()
    expect(dom.container.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-controls')).toMatch(/-start$/u)
    expect(dom.container.querySelector('.agent-work-setup')?.closest('[hidden]')).toBeNull()
  })
  it('reveals the same guide after retained narrow binding detail without replacing original work', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 600 } as DOMRect))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(vi.fn())
    const launch = vi.spyOn(api.sessions, 'launchAgent'), resume = vi.spyOn(api.sessions, 'resume'), stop = vi.spyOn(api.sessions, 'stop')
    const first = { section: 'remote-execution' as const }
    await dom.render(<SettingsPanel initialSection="remote-execution" visible navigationRequest={first} onClose={close} />)
    await selectWork('[data-resource-row="original-one"]')
    expect(dom.container.querySelector<HTMLElement>('[data-settings-field="prepare"]')!.hidden).toBe(true)
    expect(dom.container.querySelector('[data-remote-binding="binding-one"]')).not.toBeNull()
    const drafts = useAppStore.getState().agentComposerDrafts
    const sessions = useAppStore.getState().sessions
    await dom.render(<SettingsPanel initialSection="remote-execution" visible={false} navigationRequest={first} onClose={close} />)
    await dom.render(<SettingsPanel initialSection="remote-execution" visible navigationRequest={{ section: 'remote-execution', field: 'guide' }} onClose={close} />)
    const guide = dom.container.querySelector<HTMLDetailsElement>('[data-settings-field="guide"]')!
    await act(async () => guide.dispatchEvent(new Event('toggle')))
    expect(guide.closest('[hidden], [inert]')).toBeNull()
    expect(guide.open).toBe(true)
    expect(guide.querySelector('.remote-execution-guide__body')).not.toBeNull()
    expect(dom.container.querySelector('[data-resource-row="original-one"][aria-selected="true"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-remote-binding="binding-one"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(useAppStore.getState().sessions).toBe(sessions)
    expect(useAppStore.getState().sessions[0]).toBe(one)
    expect(launch).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    expect(observe).toHaveBeenCalled()
  })
  it('opens the complete Core guide in the original document reader without creating, resuming or stopping work', async () => {
    const launch = vi.spyOn(api.sessions, 'launchAgent'), resume = vi.spyOn(api.sessions, 'resume'), stop = vi.spyOn(api.sessions, 'stop')
    const prepare = vi.spyOn(useAppStore.getState(), 'openLauncher'), before = useAppStore.getState()
    await pane()
    expect(dom.container.querySelector('.remote-execution-guide__body')).toBeNull()
    await dom.click('[data-settings-field="guide"] button')
    const body = document.querySelector<HTMLElement>('.documentation-guide')
    expect(body).not.toBeNull()
    expect(AGENT_EXECUTION_GUIDE.length).toBeGreaterThan(1000)
    expect(guideText(body!.textContent!)).toBe(guideText(AGENT_EXECUTION_GUIDE))
    const sourceHeadings = [...AGENT_EXECUTION_GUIDE.matchAll(/^## (.+)$/gmu)].map(match => match[1])
    expect(sourceHeadings.length).toBeGreaterThan(0)
    expect([...body!.querySelectorAll('.md-heading[data-level="2"]')].map(heading => heading.textContent)).toEqual(sourceHeadings)
    expect(body!.querySelector('button, a, [contenteditable="true"]')).toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close documentation"]')!.click())
    expect(document.querySelector('.documentation-dialog')).toBeNull()
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(prepare).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('resolves the real SettingsPanel guide deep link to the original documentation action', async () => {
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    await dom.render(<DocumentationTestOwner><SettingsPanel initialSection="remote-execution" navigationRequest={{ section: 'remote-execution', field: 'guide' }} onClose={close} /></DocumentationTestOwner>)
    const guide = dom.container.querySelector<HTMLElement>('[data-settings-pane="remote-execution"] [data-settings-field="guide"]')
    expect(guide).not.toBeNull()
    expect(guide!.dataset.settingsSearchHighlight).toBe('')
    expect(document.querySelector('.documentation-dialog')).toBeNull()
    await act(async () => guide!.querySelector<HTMLButtonElement>('button')!.click())
    const documentBody = document.querySelector('.documentation-guide')
    expect(documentBody).not.toBeNull()
    expect(guideText(documentBody!.textContent!)).toBe(guideText(AGENT_EXECUTION_GUIDE))
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('is one compiled Remote navigation contribution and its real page is reachable', async () => {
    expect(settingsNavGroups('').find(group => group.id === 'environment')?.items.map(item => item.id).filter(id => ['hosts', 'remote-execution', 'mobile'].includes(id))).toEqual(['hosts', 'remote-execution', 'mobile'])
    expect(visibleSettingsSections('Remote execution').map(item => item.id)).toContain('remote-execution')
    await dom.render(<SettingsPanel initialSection="overview" onClose={close} />)
    await dom.click('nav [data-settings-target="remote-execution"]')
    expect(dom.container.querySelector('[data-settings-pane="remote-execution"] [aria-label="Working folder for this arrangement"]')).toBeNull()
    expect(dom.container.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('Existing work')
  })

  it('prepares the exact chosen Project through the real Store and retains drafts without starting an Agent', async () => {
    const open = vi.spyOn(useAppStore.getState(), 'openLauncher'), split = vi.spyOn(useAppStore.getState(), 'setLauncherAgentWorkspace')
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'remote', homeDirectory: '/same/project' })
    const before = useAppStore.getState()
    await pane(); await startPreparation(); await chooseProject('project-local'); await chooseField('Agent runs on', 'remote'); await button('Open in Launcher')
    expect(open).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'project-local', reveal: true, initialExecution: { resourceWorkspaceId: 'project-local', agentWorkspaceId: 'project-remote' } })
    const tabId = open.mock.results[0]!.value as string
    expect(tabId).toBeTruthy()
    const after = useAppStore.getState(), tab = after.tabs[tabId]!
    expect(split).not.toHaveBeenCalled()
    expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ kind: 'launcher', workspaceId: 'project-local', agentWorkspaceId: 'project-remote' })
    expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
    expect(after.sessions).toBe(before.sessions)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  })

  it('excludes Scratch and preserves the page when original Launcher preparation is unavailable', async () => {
    await pane(); await startPreparation()
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Working folder for this arrangement"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    const options = [...document.querySelectorAll<HTMLElement>('[role=menuitemradio][data-value]')].map(item => item.dataset.value)
    expect(options).toContain('project-local'); expect(options).not.toContain('project-remote'); expect(options).not.toContain('__scratch__')
    vi.spyOn(useAppStore.getState(), 'openLauncher').mockReturnValue(undefined)
    const split = vi.spyOn(useAppStore.getState(), 'setLauncherAgentWorkspace')
    await act(async () => document.querySelector<HTMLElement>('[role=menuitemradio][data-value="project-local"]')!.click())
    vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'remote', homeDirectory: '/same/project' })
    await chooseField('Agent runs on', 'remote'); await button('Open in Launcher')
    expect(split).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })

  it('selects original Session IDs despite duplicate presentation and releases only that reader on hide', async () => {
    const stops = [vi.fn(), vi.fn()]
    const observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation(id => stops[id === 'binding-one' ? 0 : 1]!)
    const controlStop = vi.spyOn(api.sessions, 'stop')
    await pane()
    expect(dom.container.querySelector('[data-resource-row="ordinary"]')).toBeNull()
    await selectWork('[data-resource-row="original-one"]')
    expect(observe.mock.calls.at(-1)?.[0]).toBe('binding-one')
    await selectWork('[data-resource-row="original-two"]')
    expect(observe.mock.calls.at(-1)?.[0]).toBe('binding-two'); expect(stops[0]).toHaveBeenCalledOnce()
    await pane(false)
    expect(stops[1]).toHaveBeenCalledOnce(); expect(controlStop).not.toHaveBeenCalled()
    const count = observe.mock.calls.length
    await act(async () => useAppStore.setState({ error: 'Unrelated observation' }))
    expect(observe).toHaveBeenCalledTimes(count)
  })

  it('shows healthy original binding details and refreshes it while rejecting a foreign or stale receipt', async () => {
    let emit!: (value: AgentExecutionInspection | null) => void, fail!: (error: string) => void
    vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, listener, error) => { emit = listener; fail = error; return vi.fn() })
    let resolve!: (value: AgentExecutionInspection | null) => void
    const read = vi.spyOn(api.sessions, 'executionBinding').mockImplementation(() => new Promise(done => { resolve = done }))
    await pane(); await selectWork('[data-resource-row="original-one"]')
    await act(async () => emit(fact()))
    expect(dom.container.textContent).toContain('Tool connection · Connected')
    await act(async () => emit({ ...fact(), notices: [{ providerId: 'codex', role: 'executor', capability: 'hooks', state: 'unqualified',
      code: 'HOOKS_NOT_QUALIFIED', message: 'Original Hooks qualification remains unknown', action: 'Inspect the original Provider capability' }] }))
    await act(async () => emit(null))
    expect(dom.container.textContent).toContain('The original execution binding was not present in this observation.')
    expect(dom.container.textContent).toContain('Last confirmed tool connection: connected.')
    expect(dom.container.textContent).toContain('Original Hooks qualification remains unknown')
    await button('Refresh observation')
    expect(read).toHaveBeenCalledExactlyOnceWith('binding-one')
    await act(async () => emit({ ...fact(), state: 'unavailable', diagnostic: { code: 'EXACT_OWNER_UNAVAILABLE', message: 'Original owner unavailable' } }))
    await act(async () => resolve(fact()))
    expect(dom.container.textContent).toContain('Original owner unavailable')
    await act(async () => emit({ ...fact(), bindingId: 'foreign-binding' }))
    expect(dom.container.textContent).toContain('did not identify this original execution binding')
    await act(async () => fail('Observer disconnected'))
    expect(dom.container.textContent).toContain('Observer disconnected')
    expect(useAppStore.getState().sessions).toEqual([one, two, composerSession('ordinary')])
    expect(useAppStore.getState().agentComposerDrafts.retained).toBe('Do not change this authored draft')
  })

  it('opens the original Session through selection and closes Settings only on a successful navigation', async () => {
    vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(vi.fn())
    const select = vi.spyOn(useAppStore.getState(), 'selectSession').mockReturnValue(false)
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    await pane(); await selectWork('[data-resource-row="original-two"]'); await button('Open original work')
    expect(select).toHaveBeenCalledWith('original-two'); expect(close).not.toHaveBeenCalled()
    select.mockReturnValue(true); await button('Open original work')
    expect(close).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled()
  })
})
