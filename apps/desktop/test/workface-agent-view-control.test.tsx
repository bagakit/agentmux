// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { desktopElementVisible } from '../src/renderer/src/lib/desktop-presentation'
import type { SessionSnapshot } from '../src/shared/contracts'
import { effectiveSessionViewMode } from '../src/renderer/src/lib/session-presentation'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { agent, config, neighborSid, protectedFacts, regionIdA, regionIdB, regionIdC,
  runWorkfaceRestore, startWorkfaceFixture, tabId, targetSid } from './helpers/workface-control-fixture'

// Actual SessionPane, ActivityView, AgentSessionComposer, preference helper and Store stay real.
// Only the native PTY painter is isolated; no production App, Run or Runtime is controlled.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) =>
  <div data-private-terminal={session.id} className="xterm">Original private Terminal painting<textarea aria-label="Private terminal input" /></div> }))

const original = useAppStore.getState()
const restoring = process.env.AGENTMUX_WORKFACE_RESTORE_PHASE === 'agent-child'
const restoreName = 'ordinary independent process restores Agent preference, original references and actual Pane'
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>> | undefined
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(original, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  if (!restoring) fixture = await startWorkfaceFixture()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); await fixture?.stop(); fixture = undefined
  vi.restoreAllMocks(); useAppStore.setState(original, true); vi.unstubAllGlobals()
})
const args = (mode?: string, id = targetSid) => ['agent', 'view', '--session', id, ...(mode === undefined ? [] : ['--mode', mode])]
async function view(mode?: string, id = targetSid, code = 0) {
  const receipt = await fixture!.run(args(mode, id), code)
  expect(receipt.operation).toBe('agent.view')
  if (receipt.operation !== 'agent.view') throw new Error('Wrong Agent view receipt.')
  return receipt.result
}
function panes(id = targetSid) {
  return <><div data-pane="first"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'resource', tabGroupId: 'resource-group', tabId, regionId: regionIdA }} /></div>
    <div data-pane="second"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: 'resource', tabGroupId: 'resource-group', tabId, regionId: regionIdB }} /></div>
    <div data-pane="neighbor"><SessionPane sessionId={neighborSid} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: 'resource', tabGroupId: 'resource-group', tabId, regionId: regionIdC }} /></div></>
}
async function mount(id = targetSid) { await act(async () => root.render(panes(id))) }
function modes() {
  const values = [...container.querySelectorAll<HTMLElement>('[data-agent-surface-mode]')].map(element => element.dataset.agentSurfaceMode)
  expect(values).toHaveLength(3)
  return values
}
const saved = { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }

describe.skipIf(restoring)('Agent view through compiled CLI and actual consumers', () => {
  it('reads current default and every original reference without a write, save, snapshot or navigation', async () => {
    const setter = vi.spyOn(useAppStore.getState(), 'setViewMode'), before = protectedFacts()
    const activeElement = vi.spyOn(document, 'activeElement', 'get')
    const result = await view()
    expect(result).toMatchObject({ scope: 'agent-session', agentSessionId: targetSid, storedOverride: null,
      effectiveMode: 'terminal', sessionFacts: 'known', changed: false, outcome: 'read', save: null, issues: [] })
    expect(result.regions.map(region => region.regionId)).toEqual([regionIdA, regionIdB, 'workface-region-other'])
    expect(result.locations.map(location => [location.displayWorkspaceId, location.regionId])).toEqual([
      ['resource', regionIdA], ['resource', regionIdB], ['resource', 'workface-region-other'], ['display', regionIdA], ['display', regionIdB] ])
    expect(setter).not.toHaveBeenCalled(); expect(fixture!.flush).not.toHaveBeenCalled(); fixture!.noLifecycle()
    expect(activeElement).not.toHaveBeenCalled()
    expect(protectedFacts()).toEqual(before)
  })
  it('changes both actual Pane and Composer modes while retaining the eligible neighbor input and original identities', async () => {
    await mount(); expect(modes()).toEqual(['terminal', 'terminal', 'terminal'])
    const input = container.querySelector<HTMLElement>('[data-pane="neighbor"] [aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); await act(async () => input.focus()); expect(document.activeElement).toBe(input)
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    expect(desktopElementVisible(input)).toBe(true)
    const before = protectedFacts(), setter = vi.spyOn(useAppStore.getState(), 'setViewMode')
    let result!: Awaited<ReturnType<typeof view>>
    await act(async () => { result = await view('activity') })
    expect(result).toMatchObject({ storedOverride: 'activity', effectiveMode: 'activity', changed: true, outcome: 'changed', save: saved })
    expect(setter).toHaveBeenCalledExactlyOnceWith(targetSid, 'activity', { focus: false })
    expect(modes()).toEqual(['activity', 'activity', 'terminal'])
    for (const name of ['first', 'second']) {
      const pane = container.querySelector(`[data-pane="${name}"]`)!
      expect(pane.querySelector('.activity-feed')).not.toBeNull()
      expect(pane.querySelector('[data-private-terminal]')).toBeNull()
      expect(pane.querySelector('button[aria-label="Show Terminal"]')).not.toBeNull()
      expect(pane.querySelector('[aria-label="Message Agent"]')?.textContent).toBe('Original unsent target draft')
    }
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
    expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
    expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.viewModes).toEqual({ [neighborSid]: 'terminal', [targetSid]: 'activity' })
    await act(async () => { result = await view('terminal') })
    expect(result).toMatchObject({ storedOverride: 'terminal', effectiveMode: 'terminal', changed: true })
    expect(modes()).toEqual(['terminal', 'terminal', 'terminal'])
    expect(document.activeElement).toBe(input); expect(protectedFacts()).toEqual(before)
  })
  it('keeps the original actual Composer GUI focus behavior while CLI writes remain presentation-only', async () => {
    await mount()
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(neighborSid)
    const toggle = container.querySelector<HTMLButtonElement>('[data-pane="first"] button[aria-label="Show Activity"]')!
    expect(toggle).not.toBeNull(); await act(async () => toggle.click())
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(targetSid)
    expect(modes()).toEqual(['activity', 'activity', 'terminal'])
    useAppStore.setState({ agentFocus: { execution: { sessionId: neighborSid, history: [{ sessionId: neighborSid, focusedAt: 1 }] }, pmo: { sessionId: null } } })
    const before = protectedFacts()
    await act(async () => { await view('terminal') })
    expect(protectedFacts()).toEqual(before)
  })
  it('reports loss of the old eligible Terminal input without focusing another input or undoing the applied mode', async () => {
    await mount()
    const input = container.querySelector<HTMLTextAreaElement>('[data-pane="first"] [aria-label="Private terminal input"]')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus()); expect(desktopElementVisible(input)).toBe(true)
    const before = protectedFacts(), focus = vi.spyOn(HTMLElement.prototype, 'focus'), blur = vi.spyOn(HTMLElement.prototype, 'blur')
    let result!: Awaited<ReturnType<typeof view>>
    await act(async () => { result = await view('activity', targetSid, 1) })
    expect(result).toMatchObject({ storedOverride: 'activity', effectiveMode: 'activity', changed: true, outcome: 'partial', save: saved })
    expect(result.issues.map(issue => issue.code)).toEqual(['INPUT_PRESERVATION_UNCONFIRMED'])
    expect(input.isConnected).toBe(false); expect(modes()).toEqual(['activity', 'activity', 'terminal'])
    expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
    expect(protectedFacts()).toEqual(before); fixture!.noLifecycle()
  })
  it('writes the original durable Agent reference when Session facts are empty without claiming a Runtime state', async () => {
    useAppStore.setState({ sessions: [] }); await prepareRendererUpdate(); fixture!.flush.mockClear()
    const before = protectedFacts()
    expect(await view('activity')).toMatchObject({ sessionFacts: 'unconfirmed', storedOverride: 'activity', effectiveMode: 'activity', outcome: 'changed', save: saved })
    expect(protectedFacts()).toEqual(before); expect(before.sessions).toEqual([])
    expect(Object.keys(before.tabs)).toEqual([tabId, 'workface-other-tab']); fixture!.noLifecycle()
    fixture!.flush.mockClear()
    expect(await view()).toMatchObject({ sessionFacts: 'unconfirmed', storedOverride: 'activity', outcome: 'read', save: null })
    expect(fixture!.flush).not.toHaveBeenCalled()
  })
  it.each(['constructor', 'toString', '__proto__'])('reads only legal own modes for opaque Session %s in the actual Pane and query', async id => {
    useAppStore.setState({ sessions: [agent(id), agent(neighborSid)], viewModes: { [neighborSid]: 'terminal' },
      pendingAgentLaunches: Object.create(null), agentNames: { [id]: 'Original opaque Agent' },
      timelines: { [id]: { agentSessionId: id, revision: 1, items: [] } }, agentSteerQueues: { [id]: [] },
      agentComposerDrafts: { [id]: 'Original unsent target draft', [neighborSid]: 'Original unsent neighbor draft' } })
    await prepareRendererUpdate(); fixture!.flush.mockClear()
    expect(await view(undefined, id)).toMatchObject({ storedOverride: null, effectiveMode: 'terminal', outcome: 'read' })
    await mount(id); expect(modes()).toEqual(['terminal', 'terminal', 'terminal'])
    useAppStore.setState({ viewModes: { [neighborSid]: 'terminal', [id]: 'invalid-mode' as never } })
    await act(async () => {})
    expect(await view(undefined, id)).toMatchObject({ storedOverride: null, effectiveMode: 'terminal' })
    expect(modes()).toEqual(['terminal', 'terminal', 'terminal'])
    await act(async () => { await view('activity', id) })
    expect(modes()).toEqual(['activity', 'activity', 'terminal'])
    expect(Object.hasOwn(useAppStore.getState().viewModes, id)).toBe(true)
    expect(await view(undefined, id)).toMatchObject({ storedOverride: 'activity', effectiveMode: 'activity' })
  })
  it('reports unchanged actual preference and retains applied mode on failed save without rolling back a later user edit', async () => {
    expect(await view('activity')).toMatchObject({ changed: true, save: saved })
    expect(await view('activity')).toMatchObject({ changed: false, outcome: 'unchanged', save: saved })
    fixture!.flush.mockRejectedValue(new Error('Private save unavailable'))
    expect(await view('terminal', targetSid, 1)).toMatchObject({ storedOverride: 'terminal', effectiveMode: 'terminal', changed: true,
      outcome: 'partial', save: { ...saved, storageFlushRequested: false, reason: 'Private save unavailable' } })
    expect(useAppStore.getState().viewModes[targetSid]).toBe('terminal')
    expect(useAppStore.getState().workbenchSaveWarning).toContain('Private save unavailable')
    let release!: () => void
    const saving = new Promise<void>(resolve => { release = resolve })
    fixture!.flush.mockImplementation(() => saving)
    const pending = view('activity'); await vi.waitFor(() => expect(useAppStore.getState().viewModes[targetSid]).toBe('activity'))
    useAppStore.getState().setViewMode(targetSid, 'terminal', { focus: false }); release()
    expect(await pending).toMatchObject({ storedOverride: 'activity', changed: true })
    expect(useAppStore.getState().viewModes[targetSid]).toBe('terminal')
  })
  it('keeps unknown SID facts honest and does not treat an observed Terminal as an Agent', async () => {
    const setter = vi.spyOn(useAppStore.getState(), 'setViewMode'), before = protectedFacts()
    const unknown = await view('activity', 'unconfirmed-agent', 1)
    expect(unknown).toMatchObject({ storedOverride: null, effectiveMode: null, sessionFacts: 'unconfirmed', outcome: 'unknown', save: null })
    expect(unknown.issues.map(issue => issue.code)).toEqual(['UNKNOWN_AGENT_SESSION'])
    const terminal: SessionSnapshot = { id: 'terminal-only', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/private/workface-execution',
      label: 'Original shell', createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
      control: { kind: 'terminal', hostId: 'local', runId: 'original-shell-run', run: { runId: 'original-shell-run' } } }
    useAppStore.setState({ sessions: [...useAppStore.getState().sessions, terminal] }); await prepareRendererUpdate(); fixture!.flush.mockClear()
    expect(await view('activity', terminal.id, 1)).toMatchObject({ outcome: 'unknown', effectiveMode: null, save: null })
    expect(setter).not.toHaveBeenCalled(); expect(fixture!.flush).not.toHaveBeenCalled(); fixture!.noLifecycle()
    expect(protectedFacts()).toEqual({ ...before, sessions: [...before.sessions, terminal] })
  })
})

it(restoreName, async () => {
  if (restoring) {
    const payload = JSON.parse(await readFile(process.env.AGENTMUX_WORKFACE_RESTORE_RECORD!, 'utf8'))
    expect(process.pid).not.toBe(payload.parentPid)
    localStorage.setItem('agentmux-workbench-v1', payload.record)
    vi.spyOn(api.config, 'get').mockResolvedValue(config); vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.demands, 'list').mockResolvedValue([]); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent(targetSid), agent(neighborSid)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    const dispose = await useAppStore.getState().initialize()
    try {
      expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId, session.hostId, session.workspacePath])).toEqual([
        [targetSid, agent(targetSid).control.run.runId, 'local', '/private/workface-execution'],
        [neighborSid, agent(neighborSid).control.run.runId, 'local', '/private/workface-execution'] ])
      expect(useAppStore.getState().tabs).toEqual(payload.tabs); expect(useAppStore.getState().layouts).toEqual(payload.layouts)
      expect(useAppStore.getState().agentComposerDrafts).toEqual(payload.drafts)
      expect(useAppStore.getState().viewModes).toEqual({ [neighborSid]: 'terminal', [targetSid]: 'activity' })
      expect(effectiveSessionViewMode(useAppStore.getState(), targetSid)).toBe('activity')
      await mount(); expect(modes()).toEqual(['activity', 'activity', 'terminal'])
      expect(container.querySelector('[data-pane="first"] [aria-label="Message Agent"]')?.textContent).toBe('Original unsent target draft')
      await writeFile(payload.childProof, JSON.stringify({ parentPid: payload.parentPid, pid: process.pid,
        recordSha256: createHash('sha256').update(payload.record).digest('hex'), modes: modes(), tabs: useAppStore.getState().tabs,
        layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts }, null, 2))
    } finally { dispose() }
    return
  }
  expect(await view('activity')).toMatchObject({ storedOverride: 'activity', effectiveMode: 'activity', changed: true })
  const proof = await runWorkfaceRestore('apps/desktop/test/workface-agent-view-control.test.tsx', restoreName, 'agent-child')
  expect(proof.modes).toEqual(['activity', 'activity', 'terminal'])
}, 40_000)
