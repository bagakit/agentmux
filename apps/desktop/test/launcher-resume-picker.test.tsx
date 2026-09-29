// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionRecoveryCandidate, AppConfig, SessionRecoveryResult, SessionSnapshot } from '../src/shared/contracts.js'
import { LauncherResumePicker } from '../src/renderer/src/components/LauncherResumePicker.js'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation.js'
import { api } from '../src/renderer/src/lib/api.js'
import { recoveryCandidateSession, useAppStore } from '../src/renderer/src/store.js'
import { createWorkbenchTab, sessionTabId } from '../src/renderer/src/lib/workbench-tabs.js'
import { hydratePersistedTab, projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence.js'
import * as resumeFacts from '../src/renderer/src/lib/launcher-resume.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, { id: 'remote', kind: 'ssh', label: 'Build Host', hostname: 'example.test' }],
  executors: { codex: { label: 'Code Review', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [
    { id: 'project', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' },
    { id: 'branch', name: 'Feature branch', hostId: 'local', path: '/repo/.worktrees/feature', kind: 'worktree', repoPath: '/repo', branch: 'feature' },
    { id: 'other', name: 'Other project', hostId: 'local', path: '/other', kind: 'folder' },
    { id: 'remote-project', name: 'Remote project', hostId: 'remote', path: '/repo', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const workspace = config.workspaces[0]!
const initial = useAppStore.getState()
let container: HTMLDivElement
let root: Root

function candidate(id: string, path = '/repo', hostId = 'local', updatedAt = 1000): AgentSessionRecoveryCandidate {
  return { agentSessionId: id, hostId, workspacePath: path, providerId: 'codex', executorId: 'codex',
    capabilities: { providerResume: true } as AgentSessionRecoveryCandidate['capabilities'],
    label: `Agent ${id}`, createdAt: 500, updatedAt, run: { runId: `old-${id}` } }
}
function timeline(id: string, prompt: string, answer: string): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 2, items: [
    { id: `${id}-user`, agentSessionId: id, kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: 100, updatedAt: 100, title: 'Prompt', content: prompt },
    { id: `${id}-answer`, agentSessionId: id, kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: 200, updatedAt: 200, title: 'Reply', content: answer }
  ] }
}
function page(id: string, text?: string): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: null,
    items: text ? [{ id: `last-${id}`, kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }] : [] }
}
function running(source: AgentSessionRecoveryCandidate): SessionSnapshot {
  return { ...recoveryCandidateSession(source, { kind: 'pending', detail: 'Pending check' }), processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 2000 },
    control: { kind: 'agent', hostId: source.hostId, agentSessionId: source.agentSessionId, run: { runId: `new-${source.agentSessionId}` } } } as SessionSnapshot
}
function seed(candidates: AgentSessionRecoveryCandidate[], extra: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  const tab = createWorkbenchTab('launcher', { regionId: 'launcher-region', kind: 'launcher', workspaceId: workspace.id })
  useAppStore.setState({ config, activeWorkspaceId: workspace.id, mainSurface: 'workbench', recoveryCandidates: candidates,
    sessions: [], timelines: {}, agentNames: {}, tabs: { launcher: tab }, layouts: { project: createWorkspaceLayout('group', ['launcher']) },
    agentComposerDrafts: { 'launcher-region': 'UNSENT DRAFT' }, error: null, lastError: null, errorNoticeContext: null,
    ...extra })
}
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const optionIds = () => options().map(option => option.id.slice(option.id.lastIndexOf('-') + 1))
function button(label: string | RegExp, owner: ParentNode = document) {
  const found = [...owner.querySelectorAll<HTMLButtonElement>('button')].find(item => typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent ?? ''))
  if (!found) throw new Error(`Button missing: ${label}`)
  return found
}
async function click(target: HTMLElement) { await act(async () => target.click()) }
async function open(candidates: AgentSessionRecoveryCandidate[], extra?: Partial<ReturnType<typeof useAppStore.getState>>) {
  seed(candidates, extra)
  await act(async () => root.render(<LauncherResumePicker workspace={workspace} />))
  await click(button('Resume', container))
}
async function search(query: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search saved Sessions"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async identity => page(identity.agentSessionId))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

describe('Launcher saved Session picker', () => {
  it('scopes by real Host and registered Project including its worktree, without guessing child paths', async () => {
    await open([candidate('main'), candidate('branch', '/repo/.worktrees/feature'), candidate('child', '/repo/child'),
      candidate('prefix', '/repo-other'), candidate('remote', '/repo', 'remote'), candidate('other', '/other')])
    expect(optionIds()).toEqual(['branch', 'main'])
    expect(button(/This project/).textContent).toContain('2')
    expect(dialog().querySelector('.launcher-resume__footer')?.textContent).toContain('2 Sessions')
    await click(button(/All projects/))
    expect(optionIds()).toEqual(['branch', 'child', 'main', 'other', 'prefix', 'remote'])
    await click(options().find(option => option.id.endsWith('-remote'))!)
    expect(dialog().querySelector('.launcher-resume__detail')?.textContent).toContain('Build Host')
    expect(dialog().querySelector('.launcher-resume__detail')?.textContent).toContain('Remote project')
  })

  it('keeps a scope chooser with no local candidates and with no candidates at all', async () => {
    await open([candidate('other', '/other')])
    expect(options()).toEqual([])
    expect(dialog().textContent).toContain('No saved Sessions in this project')
    await click(button(/Browse all projects/))
    expect(optionIds()).toEqual(['other'])
    await act(async () => useAppStore.setState({ recoveryCandidates: [] }))
    expect(options()).toEqual([])
    expect(dialog().textContent).toContain('No saved Sessions yet')
  })

  it('shows true names, sourced recap, Provider/Executor, time and distinguishable IDs; searches these facts', async () => {
    const a = candidate('abcdefgh-one'), b = candidate('abcdefgh-two', '/repo', 'local', 2000)
    await open([a, b], { timelines: { [a.agentSessionId]: timeline(a.agentSessionId, 'Original request', 'Recap: investigate transport ownership') }, agentNames: { [a.agentSessionId]: 'Transport reviewer' } })
    expect(options()).toHaveLength(2)
    await search('transport ownership')
    expect(optionIds()).toEqual(['one'])
    const detail = dialog().querySelector('.launcher-resume__detail')!
    expect(detail.textContent).toContain('Transport reviewer')
    expect(detail.textContent).toContain('Last assistant message · Captured conversation')
    expect(detail.textContent).toContain('Codex · Code Review')
    expect(detail.textContent).toContain('abcdefgh-one')
    expect(detail.querySelector('time')?.dateTime).toBe(new Date(1000).toISOString())
    expect(options()[0]?.querySelector('code')?.textContent).toBe('#abcdefgh-o…')
    await search('abcdefgh-two')
    expect(optionIds()).toEqual(['two'])
    await search('Code Review Project')
    expect(options()).toHaveLength(2)
    expect(api.sessions.historyPage).not.toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: a.agentSessionId }), expect.anything())
  })

  it('reads only the selected native conversation page, enforces its identity and discards late selection replies', async () => {
    let releaseFirst!: (value: AgentSessionHistoryPage) => void
    vi.mocked(api.sessions.historyPage).mockImplementation(identity => identity.agentSessionId === 'first'
      ? new Promise(resolve => { releaseFirst = resolve }) : Promise.resolve(page(identity.agentSessionId, 'Second actual recap')))
    await open([candidate('first', '/repo', 'local', 2000), candidate('second')])
    expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
    expect(api.sessions.historyPage).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'first' }, { limit: 6 })
    await click(options().find(option => option.id.endsWith('-second'))!)
    expect(api.sessions.historyPage).toHaveBeenCalledTimes(2)
    expect(api.sessions.historyPage).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'second' }, { limit: 6 })
    expect(dialog().querySelector('.launcher-resume__detail')?.textContent).toContain('Second actual recap')
    await act(async () => releaseFirst(page('first', 'OLD selection must not land')))
    expect(dialog().textContent).not.toContain('OLD selection must not land')
    expect(dialog().querySelector('.launcher-resume__detail')?.textContent).toContain('Second actual recap')
  })

  it('reports unknown recap honestly and keeps resume available after the selected read fails', async () => {
    vi.mocked(api.sessions.historyPage).mockRejectedValue(new Error('Native conversation read failed'))
    await open([candidate('unknown')])
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('No recap available')
    expect(dialog().textContent).toContain('Native conversation read failed')
    expect(dialog().textContent).toContain('Resume remains available')
    expect(button('Resume Session').disabled).toBe(false)
    vi.mocked(api.sessions.historyPage).mockResolvedValue(page('unknown', 'A recovered recap'))
    await click(button('Retry recap'))
    expect(dialog().textContent).toContain('A recovered recap')
    expect(dialog().textContent).not.toContain('Native conversation read failed')
  })

  it('rejects an unrelated native page instead of showing another Session’s recap', async () => {
    vi.mocked(api.sessions.historyPage).mockResolvedValue(page('wrong', 'Foreign private recap'))
    await open([candidate('chosen')])
    expect(options()).toHaveLength(1)
    expect(dialog().textContent).toContain('Conversation read returned another Session identity')
    expect(dialog().textContent).not.toContain('Foreign private recap')
    expect(button('Resume Session').disabled).toBe(false)
  })

  it('executes the real Store path for a catalogue-only exact Session, opens its original project and preserves the launcher/draft/healthy Run', async () => {
    const first = candidate('first'), chosen = candidate('chosen', '/other', 'local', 2000), healthy = running(candidate('healthy'))
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: running(chosen) })
    const stop = vi.spyOn(api.sessions, 'stop')
    await open([first, chosen], { sessions: [healthy] })
    const prior = useAppStore.getState()
    await click(button(/All projects/)); await click(options().find(option => option.id.endsWith('-chosen'))!)
    await click(button('Resume Session'))
    expect(recover).toHaveBeenCalledWith({ kind: 'agent', hostId: 'local', agentSessionId: 'chosen', run: { runId: 'old-chosen' } }, '/other', expect.any(String))
    const state = useAppStore.getState()
    expect(state.sessions.map(session => session.id)).toEqual(['healthy', 'chosen'])
    expect(state.sessions.find(session => session.id === 'chosen')).toMatchObject({ id: 'chosen', workspacePath: '/other', processState: 'running', control: { run: { runId: 'new-chosen' } } })
    expect(state.tabs[sessionTabId('chosen')]?.workspaceId).toBe('other')
    expect(state.activeWorkspaceId).toBe('other')
    expect(state.tabs.launcher).toBe(prior.tabs.launcher)
    expect(state.sessions.find(session => session.id === 'healthy')).toBe(healthy)
    expect(state.agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
    expect(stop).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens an unregistered project by the original Host/path before restoring this exact Session', async () => {
    const chosen = candidate('unregistered', '/original-project', 'remote')
    const add = vi.spyOn(api.workspaces, 'add').mockImplementation(async input => {
      const registered = { id: 'new-project', name: 'Original project', kind: 'folder' as const, ...input }
      useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, registered] } })
      return registered
    })
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: running(chosen) })
    await open([chosen]); await click(button(/All projects/))
    expect(dialog().textContent).toContain('Project is not registered')
    await click(button('Open project & resume'))
    expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: 'remote', path: '/original-project' })
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'remote', agentSessionId: 'unregistered' }), '/original-project', expect.any(String))
    expect(useAppStore.getState().tabs[sessionTabId('unregistered')]?.workspaceId).toBe('new-project')
    expect(useAppStore.getState().sessions.map(session => [session.id, session.hostId, session.workspacePath])).toEqual([['unregistered', 'remote', '/original-project']])
  })

  it('keeps the saved Tab visible across a serialized restart and recovery refusal, and reuses its exact Region on retry', async () => {
    const chosen = candidate('retained'), savedTab = createWorkbenchTab('saved-view', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'project', sessionId: chosen.agentSessionId })
    const persisted = projectPersistedWorkbench({ tabs: { [savedTab.id]: savedTab }, layouts: { project: createWorkspaceLayout('saved-group', [savedTab.id]) } })
    const reloaded = JSON.parse(JSON.stringify(persisted)) as typeof persisted
    const restoredTab = hydratePersistedTab(reloaded.tabs[savedTab.id]!)
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'unavailable', reason: 'provider-resume-unsupported', agentSessionId: chosen.agentSessionId,
      previousRun: chosen.run, evidence: { kind: 'run-missing', observedAt: 2000 } } satisfies SessionRecoveryResult)
    const stop = vi.spyOn(api.sessions, 'stop')
    await open([chosen], { tabs: { [savedTab.id]: restoredTab }, layouts: reloaded.layouts })
    await click(button('Resume Session'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(useAppStore.getState().tabs[savedTab.id]).toBe(restoredTab)
    expect(useAppStore.getState().layouts).toBe(reloaded.layouts)
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['retained'])
    expect(dialog().textContent).toContain('Resume unavailable')
    expect(dialog().textContent).toContain('This Provider does not support native session resume.')
    expect(dialog().textContent).toContain('Restoring this Session did not complete')
    recover.mockResolvedValue({ kind: 'resumed', session: running(chosen) })
    await click(button('Resume Session'))
    expect(useAppStore.getState().tabs[savedTab.id]?.regions['original-region']).toMatchObject({ kind: 'agent', sessionId: 'retained' })
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(['saved-view'])
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['retained'])
    expect(stop).not.toHaveBeenCalled()
  })

  it('preserves picker, original draft and Session when recovery throws; keyboard chooses the exact second candidate', async () => {
    const first = candidate('first', '/repo', 'local', 2000), second = candidate('second')
    const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Core transport unavailable'))
    await open([first, second])
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search saved Sessions"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(options().map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'second' }), '/repo', expect.any(String))
    expect(dialog().textContent).toContain('Core transport unavailable')
    expect(useAppStore.getState().agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
    expect(useAppStore.getState().tabs[sessionTabId('second')]).toBeDefined()
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['second'])
    expect(button('Resume Session').disabled).toBe(false)
  })

  it('keeps an unavailable Host visible without touching other candidates and opens the existing Host settings route', async () => {
    const route = vi.fn(), absent = candidate('absent', '/repo', 'lost-host')
    seed([absent, candidate('available')])
    await act(async () => root.render(<SettingsNavigation.Provider value={{ open: route }}><LauncherResumePicker workspace={workspace} /></SettingsNavigation.Provider>))
    await click(button('Resume', container)); await click(button(/All projects/)); await click(options().find(option => option.id.endsWith('-absent'))!)
    expect(options()).toHaveLength(2)
    expect(dialog().textContent).toContain('Host is not configured')
    await click(button('Configure Host'))
    expect(route).toHaveBeenCalledExactlyOnceWith('hosts')
    expect(useAppStore.getState().recoveryCandidates.map(item => item.agentSessionId)).toEqual(['absent', 'available'])
  })

  it('binds a late recovery failure to its original Session while the user browses another selection', async () => {
    let reject!: (cause: Error) => void
    vi.spyOn(api.sessions, 'recover').mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
    vi.spyOn(api.sessions, 'refresh').mockRejectedValue(new Error('No current Runtime observation'))
    await open([candidate('alpha', '/repo', 'local', 2000), candidate('beta')])
    await click(button('Resume Session'))
    await click(options().find(option => option.id.endsWith('-beta'))!)
    await act(async () => reject(new Error('Alpha recovery failed')))
    expect(dialog().querySelector('.launcher-resume__detail-heading')?.textContent).toContain('Agent beta')
    expect(dialog().querySelector('.launcher-resume__feedback')?.textContent).toContain('Agent alpha')
    expect(dialog().querySelector('.launcher-resume__feedback code')?.textContent).toBe('alpha')
    expect(dialog().textContent).toContain('Alpha recovery failed')
  })

  it('follows a Core-reported newer Run by refreshing this exact Session before reattachment', async () => {
    const source = candidate('changed'), canonical = running(source)
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValueOnce({ kind: 'conflict', agentSessionId: source.agentSessionId,
      previousRun: source.run, currentRun: canonical.control.run, reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } })
      .mockResolvedValue({ kind: 'reattachable', session: canonical })
    const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(canonical), stop = vi.spyOn(api.sessions, 'stop')
    await open([source]); await click(button('Resume Session'))
    expect(dialog().textContent).toContain('This Agent Session now belongs to Run new-changed')
    const tab = useAppStore.getState().tabs[sessionTabId('changed')]
    await click(button('Open current Session'))
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', hostId: 'local', agentSessionId: 'changed', run: { runId: 'old-changed' } })
    expect(recover).toHaveBeenLastCalledWith(canonical.control, '/repo', expect.any(String))
    expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])).toEqual([['changed', 'new-changed']])
    expect(useAppStore.getState().tabs[sessionTabId('changed')]).toBe(tab)
    expect(stop).not.toHaveBeenCalled()
  })

  it('has no closed conversation consumer and does not rebuild open candidates for unrelated Session output', async () => {
    const builds = vi.spyOn(resumeFacts, 'launcherResumeRows'), paints = vi.fn()
    seed([candidate('own')], { timelines: { own: timeline('own', 'Own prompt', 'Original recap') } })
    await act(async () => root.render(<Profiler id="resume" onRender={paints}><LauncherResumePicker workspace={workspace} /></Profiler>))
    expect(builds).not.toHaveBeenCalled()
    expect(api.sessions.historyPage).not.toHaveBeenCalled()
    const closedPaints = paints.mock.calls.length
    await act(async () => useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, foreign: timeline('foreign', 'Foreign prompt', 'Unrelated stream') } }))
    expect(paints).toHaveBeenCalledTimes(closedPaints)
    await click(button('Resume', container))
    expect(builds.mock.calls.length).toBeGreaterThan(0)
    expect(dialog().textContent).toContain('Original recap')
    const openBuilds = builds.mock.calls.length, openPaints = paints.mock.calls.length
    await act(async () => useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, foreign: timeline('foreign', 'Foreign prompt', 'Another unrelated stream') } }))
    expect(builds).toHaveBeenCalledTimes(openBuilds)
    expect(paints).toHaveBeenCalledTimes(openPaints)
    await act(async () => useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, own: timeline('own', 'Own prompt', 'Selected actual change') } }))
    expect(dialog().textContent).toContain('Selected actual change')
    expect(builds.mock.calls.slice(openBuilds).map(([input]) => input.candidates.map(item => item.agentSessionId))).toEqual([['own']])
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close resume picker"]')!)
    const afterCloseBuilds = builds.mock.calls.length, afterClosePaints = paints.mock.calls.length
    await act(async () => useAppStore.setState({ timelines: { own: timeline('own', 'Own prompt', 'Closed should not consume') }, sessions: [running(candidate('foreign'))] }))
    expect(builds).toHaveBeenCalledTimes(afterCloseBuilds)
    expect(paints).toHaveBeenCalledTimes(afterClosePaints)
    expect(api.sessions.historyPage).not.toHaveBeenCalled()
  })
})
