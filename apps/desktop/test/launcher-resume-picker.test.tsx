import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionRecoveryCandidate, AppConfig, NativeAgentSessionsInput, NativeAgentSessionsResult, SessionRecoveryResult, SessionSnapshot } from '../src/shared/contracts.js'
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
    { id: 'project', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' },
    { id: 'branch', name: 'Feature branch', hostId: 'local', path: _hygiene_fixturePath("repo/.worktrees/feature"), kind: 'worktree', repoPath: _hygiene_fixturePath("repo"), branch: 'feature' },
    { id: 'other', name: 'Other project', hostId: 'local', path: _hygiene_fixturePath("other"), kind: 'folder' },
    { id: 'remote-project', name: 'Remote project', hostId: 'remote', path: _hygiene_fixturePath("repo"), kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const workspace = config.workspaces[0]!
const initial = useAppStore.getState()
let container: HTMLDivElement
let root: Root

function candidate(id: string, path = _hygiene_fixturePath("repo"), hostId = 'local', updatedAt = _reshape_fixtureEpoch(0, 0, 1000)): AgentSessionRecoveryCandidate {
  return { agentSessionId: id, hostId, workspacePath: path, providerId: 'codex', executorId: 'codex',
    capabilities: { providerResume: true } as AgentSessionRecoveryCandidate['capabilities'],
    label: `Agent ${id}`, createdAt: _reshape_fixtureEpoch(0, 0, 500), updatedAt, run: { runId: `old-${id}` } }
}
function timeline(id: string, prompt: string, answer: string): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 2, items: [
    { id: `${id}-user`, agentSessionId: id, kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100), title: 'Prompt', content: prompt },
    { id: `${id}-answer`, agentSessionId: id, kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: _reshape_fixtureEpoch(0, 0, 200), updatedAt: _reshape_fixtureEpoch(0, 0, 200), title: 'Reply', content: answer }
  ] }
}
function page(id: string, text?: string): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: null,
    items: text ? [{ id: `last-${id}`, kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }] : [] }
}
function running(source: AgentSessionRecoveryCandidate): SessionSnapshot {
  return { ...recoveryCandidateSession(source, { kind: 'pending', detail: 'Pending check' }), processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 2000) },
    control: { kind: 'agent', hostId: source.hostId, agentSessionId: source.agentSessionId, run: { runId: `new-${source.agentSessionId}` } } } as SessionSnapshot
}
function nativeCatalog(input: NativeAgentSessionsInput, id = 'native-original', path = _hygiene_fixturePath("repo")): NativeAgentSessionsResult {
  return { hostId: input.hostId, executorId: input.executorId, providerId: 'codex', availability: 'available',
    capabilities: candidate('capabilities').capabilities,
    sessions: [{ source: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: id, transcriptPath: _hygiene_fixturePath(`history/${id}.jsonl`) },
      workspacePath: path, revision: 'original-file-lifetime' }, title: `Saved Codex ${id}`, createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 4000) }], issues: [] }
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
    await open([candidate('main'), candidate('branch', _hygiene_fixturePath("repo/.worktrees/feature")), candidate('child', _hygiene_fixturePath("repo/child")),
      candidate('prefix', _hygiene_fixturePath("repo-other")), candidate('remote', _hygiene_fixturePath("repo"), 'remote'), candidate('other', _hygiene_fixturePath("other"))])
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
    await open([candidate('other', _hygiene_fixturePath("other"))])
    expect(options()).toEqual([])
    expect(dialog().textContent).toContain('No saved Sessions in this project')
    await click(button(/Browse all projects/))
    expect(optionIds()).toEqual(['other'])
    await act(async () => useAppStore.setState({ recoveryCandidates: [] }))
    expect(options()).toEqual([])
    expect(dialog().textContent).toContain('No saved Sessions yet')
  })

  it('shows true names, sourced recap, Provider/Executor, time and distinguishable IDs; searches these facts', async () => {
    const a = candidate('abcdefgh-one'), b = candidate('abcdefgh-two', _hygiene_fixturePath("repo"), 'local', _reshape_fixtureEpoch(0, 0, 2000))
    await open([a, b], { timelines: { [a.agentSessionId]: timeline(a.agentSessionId, 'Original request', 'Recap: investigate transport ownership') }, agentNames: { [a.agentSessionId]: 'Transport reviewer' } })
    expect(options()).toHaveLength(2)
    await search('transport ownership')
    expect(optionIds()).toEqual(['one'])
    const detail = dialog().querySelector('.launcher-resume__detail')!
    expect(detail.textContent).toContain('Transport reviewer')
    expect(detail.textContent).toContain('Last assistant message · Captured conversation')
    expect(detail.textContent).toContain('Codex · Code Review')
    expect(detail.textContent).toContain('abcdefgh-one')
    expect(detail.querySelector('time')?.dateTime).toBe(new Date(_reshape_fixtureEpoch(0, 0, 1000)).toISOString())
    expect(options()[0]?.querySelector('code')?.textContent).toBe('#abcdefgh-o…')
    await search('abcdefgh-two')
    expect(optionIds()).toEqual(['two'])
    await search('Code Review Project')
    expect(options()).toHaveLength(2)
    expect(api.sessions.historyPage).not.toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: a.agentSessionId }), expect.anything())
  })

  it('deduplicates equal Provider/Executor labels while preserving distinct names in the mounted detail', async () => {
    const sameNameConfig = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, label: 'Codex' } } }
    await open([candidate('same')], { config: sameNameConfig })
    const headingLabel = () => dialog().querySelector('.launcher-resume__detail-heading > div > span')?.textContent
    expect(headingLabel()).toBe('Codex')
    await act(async () => useAppStore.setState({ config }))
    expect(headingLabel()).toBe('Codex · Code Review')
  })

  it('reads only the selected native conversation page, enforces its identity and discards late selection replies', async () => {
    let releaseFirst!: (value: AgentSessionHistoryPage) => void
    vi.mocked(api.sessions.historyPage).mockImplementation(identity => identity.agentSessionId === 'first'
      ? new Promise(resolve => { releaseFirst = resolve }) : Promise.resolve(page(identity.agentSessionId, 'Second actual recap')))
    await open([candidate('first', _hygiene_fixturePath("repo"), 'local', _reshape_fixtureEpoch(0, 0, 2000)), candidate('second')])
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
    const first = candidate('first'), chosen = candidate('chosen', _hygiene_fixturePath("other"), 'local', _reshape_fixtureEpoch(0, 0, 2000)), healthy = running(candidate('healthy'))
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: running(chosen) })
    const stop = vi.spyOn(api.sessions, 'stop')
    await open([first, chosen], { sessions: [healthy] })
    const prior = useAppStore.getState()
    await click(button(/All projects/)); await click(options().find(option => option.id.endsWith('-chosen'))!)
    await click(button('Resume Session'))
    expect(recover).toHaveBeenCalledWith({ kind: 'agent', hostId: 'local', agentSessionId: 'chosen', run: { runId: 'old-chosen' } }, _hygiene_fixturePath("other"), expect.any(String))
    const state = useAppStore.getState()
    expect(state.sessions.map(session => session.id)).toEqual(['healthy', 'chosen'])
    expect(state.sessions.find(session => session.id === 'chosen')).toMatchObject({ id: 'chosen', workspacePath: _hygiene_fixturePath("other"), processState: 'running', control: { run: { runId: 'new-chosen' } } })
    expect(state.tabs[sessionTabId('chosen')]?.workspaceId).toBe('other')
    expect(state.activeWorkspaceId).toBe('other')
    expect(state.tabs.launcher).toBe(prior.tabs.launcher)
    expect(state.sessions.find(session => session.id === 'healthy')).toBe(healthy)
    expect(state.agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
    expect(stop).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens an unregistered project by the original Host/path before restoring this exact Session', async () => {
    const chosen = candidate('unregistered', _hygiene_fixturePath("original-project"), 'remote')
    const add = vi.spyOn(api.workspaces, 'add').mockImplementation(async input => {
      const registered = { id: 'new-project', name: 'Original project', kind: 'folder' as const, ...input }
      useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, registered] } })
      return registered
    })
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: running(chosen) })
    await open([chosen]); await click(button(/All projects/))
    expect(dialog().textContent).toContain('Project is not registered')
    await click(button('Open project & resume'))
    expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: 'remote', path: _hygiene_fixturePath("original-project") })
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'remote', agentSessionId: 'unregistered' }), _hygiene_fixturePath("original-project"), expect.any(String))
    expect(useAppStore.getState().tabs[sessionTabId('unregistered')]?.workspaceId).toBe('new-project')
    expect(useAppStore.getState().sessions.map(session => [session.id, session.hostId, session.workspacePath])).toEqual([['unregistered', 'remote', _hygiene_fixturePath("original-project")]])
  })

  it('keeps the saved Tab visible across a serialized restart and recovery refusal, and reuses its exact Region on retry', async () => {
    const chosen = candidate('retained'), savedTab = createWorkbenchTab('saved-view', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'project', sessionId: chosen.agentSessionId })
    const persisted = projectPersistedWorkbench({ tabs: { [savedTab.id]: savedTab }, layouts: { project: createWorkspaceLayout('saved-group', [savedTab.id]) } })
    const reloaded = JSON.parse(JSON.stringify(persisted)) as typeof persisted
    const restoredTab = hydratePersistedTab(reloaded.tabs[savedTab.id]!)
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'unavailable', reason: 'provider-resume-unsupported', agentSessionId: chosen.agentSessionId,
      previousRun: chosen.run, evidence: { kind: 'run-missing', observedAt: _reshape_fixtureEpoch(0, 0, 2000) } } satisfies SessionRecoveryResult)
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
    const first = candidate('first', _hygiene_fixturePath("repo"), 'local', _reshape_fixtureEpoch(0, 0, 2000)), second = candidate('second')
    const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Core transport unavailable'))
    await open([first, second])
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search saved Sessions"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(options().map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'second' }), _hygiene_fixturePath("repo"), expect.any(String))
    expect(dialog().textContent).toContain('Core transport unavailable')
    expect(useAppStore.getState().agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
    expect(useAppStore.getState().tabs[sessionTabId('second')]).toBeDefined()
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['second'])
    expect(button('Resume Session').disabled).toBe(false)
  })

  it('keeps an unavailable Host visible without touching other candidates and opens the existing Host settings route', async () => {
    const route = vi.fn(), absent = candidate('absent', _hygiene_fixturePath("repo"), 'lost-host')
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
    await open([candidate('alpha', _hygiene_fixturePath("repo"), 'local', _reshape_fixtureEpoch(0, 0, 2000)), candidate('beta')])
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
    expect(recover).toHaveBeenLastCalledWith(canonical.control, _hygiene_fixturePath("repo"), expect.any(String))
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

describe('Launcher native conversation resume', () => {
  it('discovers native history only when opened and resumes the selected original conversation without a prompt', async () => {
    const discovery = vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => nativeCatalog(input))
    const resume = vi.fn(async () => running(candidate('new-managed')))
    seed([], { resumeNativeSession: resume })
    await act(async () => root.render(<LauncherResumePicker workspace={workspace} />))
    expect(discovery).not.toHaveBeenCalled()
    await click(button('Resume', container))
    expect(discovery).toHaveBeenCalled()
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('Saved Codex native-original')
    expect(dialog().textContent).toContain('Provider Session ID')
    expect(dialog().textContent).toContain('native-original')
    await click(button('Resume Session', dialog()))
    expect(resume).toHaveBeenCalledTimes(1)
    const [request, original] = resume.mock.calls[0] as unknown as [import('../src/shared/contracts.js').AgentLaunchInput, import('@agentmux/core').AgentNativeSessionCandidate]
    expect(request.nativeResumeSource).toEqual(original.source)
    expect(request.nativeResumeSource?.nativeHandle.sessionId).toBe('native-original')
    expect(request.prompt).toBeUndefined()
    expect(request.agentSessionId).not.toBe('native-original')
    expect(request.createOperationId).toBeTruthy()
    expect(useAppStore.getState().agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
  })

  it('shows running managed Sessions and removes their duplicate native history row', async () => {
    vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => nativeCatalog(input))
    const live = running({ ...candidate('live'), nativeSessionId: 'native-original' })
    const recover = vi.fn(async () => live)
    await open([], { sessions: [live], recoverSession: recover })
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('Agent live')
    expect(options()[0]!.textContent).toContain('Running')
    await click(button('Resume Session', dialog()))
    expect(recover).toHaveBeenCalledWith('live', expect.any(String), expect.objectContaining({ stillCurrent: expect.any(Function) }))
  })

  it('keeps the exact native operation and Session ID when an unknown result is retried', async () => {
    vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => nativeCatalog(input))
    const resume = vi.fn().mockRejectedValue(new Error('Native resume acknowledgement is unknown'))
    await open([], { resumeNativeSession: resume })
    await click(button('Resume Session', dialog()))
    const first = resume.mock.calls[0][0]
    expect(dialog().textContent).toContain('acknowledgement is unknown')
    expect(options()).toHaveLength(1)
    await click(button('Resume Session', dialog()))
    expect(resume.mock.calls[1][0]).toEqual(first)
    expect(useAppStore.getState().agentComposerDrafts['launcher-region']).toBe('UNSENT DRAFT')
  })

  it('reports native discovery failure while the saved managed Session remains resumable', async () => {
    vi.spyOn(api.sessions, 'nativeSessions').mockRejectedValue(new Error('History directory is unreadable'))
    const recover = vi.fn(async () => running(candidate('managed')))
    await open([candidate('managed')], { recoverSession: recover })
    expect(dialog().textContent).toContain('History directory is unreadable')
    expect(button('Retry discovery', dialog())).toBeTruthy()
    expect(button('Resume Session', dialog()).disabled).toBe(false)
    await click(button('Resume Session', dialog()))
    expect(recover).toHaveBeenCalledWith('managed', expect.any(String), expect.objectContaining({ stillCurrent: expect.any(Function) }))
  })

  it('keeps native candidates after a failed refresh and ignores unrelated conversation output', async () => {
    const discovery = vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => nativeCatalog(input))
    await open([])
    const reads = discovery.mock.calls.length
    await act(async () => useAppStore.setState({ timelines: { unrelated: timeline('unrelated', 'other', 'more output') } }))
    expect(discovery).toHaveBeenCalledTimes(reads)
    discovery.mockRejectedValue(new Error('Host observation unavailable'))
    await click(button(/All projects/, dialog()))
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('Saved Codex native-original')
    expect(dialog().textContent).toContain('Host observation unavailable')
  })

  it('uses the actual Store creation consumer and opens the resumed native Session in its original project', async () => {
    seed([])
    const native = nativeCatalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
    const restored = running({ ...candidate('adopted'), nativeSessionId: 'native-original' })
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockResolvedValue({ created: {
      kind: 'agent', agentSessionId: restored.id, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), providerId: 'codex', executorId: 'codex',
      run: restored.control.run, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 4000), nativeHandle: native.source.nativeHandle
    }, session: restored as Extract<SessionSnapshot, { kind: 'agent' }>, projectionFailures: [] })
    const result = await act(async () => useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _hygiene_fixturePath("repo"),
      agentSessionId: 'adopted', createOperationId: 'original-resume', nativeResumeSource: native.source }, native, candidate('caps').capabilities))
    expect(result?.id).toBe('adopted')
    expect(launch.mock.calls[0]![0].nativeResumeSource).toEqual(native.source)
    const state = useAppStore.getState()
    expect(state.sessions.find(session => session.id === 'adopted')?.nativeSessionId).toBe('native-original')
    expect(Object.values(state.tabs).some(tab => Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === 'adopted'))).toBe(true)
    expect(state.activeWorkspaceId).toBe('project')
  })

  it('continues a retired managed native conversation through its original Core reopen owner', async () => {
    seed([])
    const native = nativeCatalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
    native.managed = { agentSessionId: 'retired-original', executorId: 'codex', run: { runId: 'retired-run' }, state: 'retired', retiredAt: _reshape_fixtureEpoch(0, 0, 500) }
    const restored = running({ ...candidate('retired-original'), nativeSessionId: 'native-original' })
    const reopen = vi.spyOn(api.sessions, 'reopen').mockResolvedValue(restored)
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    await act(async () => useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _hygiene_fixturePath("repo"),
      agentSessionId: 'unused-new-id', createOperationId: 'retired-resume', nativeResumeSource: native.source }, native, candidate('caps').capabilities))
    expect(reopen).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: 'retired-original' }, 500, 'retired-resume')
    expect(launch).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions.some(session => session.id === 'retired-original')).toBe(true)
  })
})
