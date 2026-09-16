// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTurnUsage } from '@agentmux/core'
import type { AppConfig, RuntimeEvent, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const transport = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  handlers: new Map<string, () => unknown>(),
  calls: [] as string[]
}))
// Replace Electron's transport only. Real preload/API/Store and all headroom consumers run below.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => Object.assign(window, { [name]: api }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcRenderer: {
    async invoke(channel: string) {
      transport.calls.push(channel)
      const handler = transport.handlers.get(channel)
      if (!handler) throw new Error(`Unexpected headroom fixture IPC: ${channel}`)
      return await handler()
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      const listeners = transport.listeners.get(channel) ?? new Set()
      listeners.add(listener); transport.listeners.set(channel, listeners)
    },
    off: (channel: string, listener: (...args: unknown[]) => void) => transport.listeners.get(channel)?.delete(listener),
    send: vi.fn()
  }
}))
import '../src/preload/index'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts'
import { extractTurnUsage, parseTurnUsage } from '../../../packages/core/src/agent-usage-transcript'
import { useAppStore } from '../src/renderer/src/store'
import { AgentTreePanel } from '../src/renderer/src/components/AgentRoster'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const IDS = ['low', 'warm', 'high', 'unknown'] as const
const NOW = 1_000_000_000, initial = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private headroom fixture' }], executors: {},
  workspaces: [{ id: 'private', name: 'Headroom', hostId: 'local', path: '/private/headroom', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } }
}
let root: Root | undefined, container: HTMLDivElement, overlay: HTMLDivElement, dispose: (() => void) | undefined

function agent(id: string): Agent {
  const providerId = id === 'unknown' ? 'claude' : 'codex'
  return { id, kind: 'agent', providerId, executorId: providerId, hostId: 'local', workspacePath: '/private/headroom',
    label: id, createdAt: 1, updatedAt: NOW - 100, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'native-hook', observedAt: NOW - 100 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true,
      replyCorrelation: 'none', usage: { kind: 'native-transcript', transcriptFormat: providerId === 'codex' ? 'codex-rollout' : 'claude-jsonl' } },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `private-run-${id}` } } }
}
function current(id: string): Agent {
  const sessions = useAppStore.getState().sessions
  expect(sessions.map(session => session.id)).toEqual(IDS)
  const session = sessions.find(item => item.id === id)
  if (session?.kind !== 'agent') throw new Error(`Missing actual Agent ${id}`)
  return session
}
function nativeReading(usedTokens: number, observedAt = NOW): AgentTurnUsage {
  const content = JSON.stringify({ payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: usedTokens - 10, output_tokens: 10, total_tokens: usedTokens },
    total_token_usage: { total_tokens: 9_000_000 }, model_context_window: 1000
  } } })
  const usage = parseTurnUsage(extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'codex-rollout' }, content, observedAt))
  expect(usage?.context).toEqual({ usedTokens, capacityTokens: 1000 })
  return usage!
}
function publication(id: string, usage: AgentTurnUsage | undefined, observedAt = NOW): RuntimeEvent {
  const session = current(id)
  return { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: { ...session.control.run },
    retiredRuns: [],  createdAt: 1, updatedAt: observedAt,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt },
    ...(usage === undefined ? {} : { turnUsage: usage })
  } } }
}
async function emit(event: RuntimeEvent) {
  const listeners = transport.listeners.get(SESSION_EVENT_CHANNEL)
  expect(listeners?.size).toBe(1)
  await act(async () => {
    for (const listener of listeners!) listener({}, event)
  })
}
function Workbench() {
  const sessions = useAppStore(state => state.sessions)
  const onOpen = useAppStore(state => state.selectSession)
  return <>
    <AgentTreePanel filter="all" heading="Headroom Agents" label="Show headroom Agents" />
    <WorkspaceAgentsTool workspace={config.workspaces[0]!} sessions={sessions} onOpen={onOpen} />
    {IDS.map(id => <section data-composer-for={id} key={id}><AgentSessionComposer sessionId={id} /></section>)}
  </>
}
async function openTree() {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Show headroom Agents"]')
  expect(button).not.toBeNull()
  await act(async () => button!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.querySelector('.agent-tree')).not.toBeNull()
}
function pressureRows(selector: string) {
  const rows = [...document.querySelectorAll<HTMLElement>(selector)]
  expect(rows).toHaveLength(IDS.length)
  return Object.fromEntries(rows.map(row => {
    const label = row.querySelector('strong')?.textContent
    expect(label).toBeTruthy()
    const badge = row.querySelector<HTMLElement>('[data-pressure]')
    return [label!, badge ? { pressure: badge.dataset.pressure, text: badge.textContent } : null]
  }))
}
function composer(id: string) {
  const section = container.querySelector<HTMLElement>(`[data-composer-for="${id}"]`)
  expect(section).not.toBeNull()
  const chip = section!.querySelector<HTMLButtonElement>('.composer__context')
  expect(chip).not.toBeNull()
  const target = chip!.getAttribute('popovertarget')
  expect(target).toBeTruthy()
  const details = document.getElementById(target!)
  expect(details?.getAttribute('aria-label')).toBe('Context window')
  return { section: section!, chip: chip!, details: details! }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  transport.calls.length = 0; transport.listeners.clear(); transport.handlers.clear()
  transport.handlers.set('config:get', () => config)
  transport.handlers.set('providers:list', () => [])
  transport.handlers.set('demands:list', () => [])
  const snapshot: RuntimeSnapshot = { sessions: IDS.map(agent), timelines: {}, recoveryCandidates: [] }
  transport.handlers.set('sessions:snapshot', () => structuredClone(snapshot))
  transport.handlers.set('ui:requestStorageFlush', () => undefined)
  useAppStore.persist.clearStorage(); window.localStorage.clear()
  useAppStore.setState({ ...initial, loading: true }, true)
  await useAppStore.persist.rehydrate()
  expect(useAppStore.persist.hasHydrated()).toBe(true)
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  expect(useAppStore.getState().error).toBeNull()
  expect(transport.calls).toEqual(['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
  container = document.createElement('div'); overlay = document.createElement('div'); overlay.dataset.overlayHost = ''
  document.body.append(container, overlay); root = createRoot(container)
  await act(async () => root!.render(<Workbench />))
  await openTree()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); overlay?.remove()
  dispose?.(); dispose = undefined
  expect(transport.listeners.get(SESSION_EVENT_CHANNEL)?.size).toBe(0)
  useAppStore.persist.clearStorage(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('real preload publications reach the multi-Agent tree, workspace list and each owning Composer', async () => {
  for (const [id, used] of [['low', 690], ['warm', 700], ['high', 900]] as const) {
    await emit(publication(id, nativeReading(used)))
  }
  const expected = { low: null, warm: { pressure: 'caution', text: '70%' }, high: { pressure: 'danger', text: '90%' }, unknown: null }
  expect(pressureRows('.agent-tree [role="menuitem"]')).toEqual(expected)
  expect(pressureRows('.workspace-agent-row')).toEqual(expected)
  for (const [id, used, remaining] of [['low', 69, 31], ['warm', 70, 30], ['high', 90, 10]] as const) {
    const ui = composer(id)
    expect(ui.chip.textContent).toContain(`${used}%`)
    expect(ui.chip.getAttribute('aria-label')).toContain(`${remaining}% remaining`)
    expect(ui.details.textContent).toContain('Native observation, unsent draft excluded')
    expect(ui.details.textContent).toContain('Last observed')
    expect(ui.details.textContent).not.toContain('9000000')
  }
  const unknown = composer('unknown')
  expect(unknown.chip.textContent).toContain('—')
  expect(unknown.details.textContent).toContain('Unavailable')
  expect(unknown.details.textContent).not.toContain('0%')
  expect(document.querySelector('.agent-tree')!.textContent).toContain('70%')
  expect(document.querySelector('.agent-tree [data-pressure="danger"]')!.getAttribute('title')).toContain('start a fresh session')
  expect(transport.calls).toEqual(['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
})

it('a newer compacted reading reduces pressure while mid-turn publication keeps its original sample time', async () => {
  const sample = nativeReading(900)
  await emit(publication('high', sample))
  expect(composer('high').chip.textContent).toContain('90%')
  // The Core publishes its retained last observation in the full mid-turn Session snapshot.
  // This fixture does not claim that an absent Renderer field means "retain".
  await emit(publication('high', structuredClone(sample), NOW + 1))
  expect(current('high').turnUsage?.observedAt).toBe(NOW)
  expect(composer('high').details.textContent).toContain(new Date(NOW).toLocaleString())
  await emit(publication('high', nativeReading(200, NOW + 2), NOW + 2))
  expect(current('high').turnUsage?.context).toEqual({ usedTokens: 200, capacityTokens: 1000 })
  expect(composer('high').chip.textContent).toContain('20%')
  expect(composer('high').details.textContent).toContain('80% remaining')
  expect(composer('high').details.textContent).toContain('200 of 1.0k tokens')
  expect(pressureRows('.agent-tree [role="menuitem"]')).toEqual({ low: null, warm: null, high: null, unknown: null })
  expect(pressureRows('.workspace-agent-row')).toEqual({ low: null, warm: null, high: null, unknown: null })
})

it('an accepted authoritative usage clear removes the old number on every real consumer', async () => {
  await emit(publication('warm', nativeReading(700)))
  expect(composer('warm').chip.textContent).toContain('70%')
  expect(pressureRows('.agent-tree [role="menuitem"]')).toEqual({
    low: null, warm: { pressure: 'caution', text: '70%' }, high: null, unknown: null
  })
  await emit(publication('warm', undefined, NOW + 1))
  expect(current('warm')).not.toHaveProperty('turnUsage')
  expect(composer('warm').chip.textContent).toContain('—')
  expect(composer('warm').details.textContent).toContain('Unavailable')
  expect(composer('warm').details.textContent).not.toContain('0%')
  expect(pressureRows('.agent-tree [role="menuitem"]')).toEqual({ low: null, warm: null, high: null, unknown: null })
  expect(pressureRows('.workspace-agent-row')).toEqual({ low: null, warm: null, high: null, unknown: null })
})

it('a native turn without capacity remains unknown and does not lock the healthy Composer or change attention', async () => {
  const content = JSON.stringify({ type: 'assistant', message: { usage: {
    input_tokens: 900_000, output_tokens: 10
  } } })
  const usage = parseTurnUsage(extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }, content, NOW))
  expect(usage?.totalTokens).toBe(900_010)
  expect(usage).not.toHaveProperty('context')
  const controlsBefore = IDS.map(id => ({ id, control: structuredClone(current(id).control),
    processState: current(id).processState, state: current(id).status.state }))
  await emit(publication('unknown', usage!))
  await emit(publication('high', nativeReading(900)))
  expect(pressureRows('.agent-tree [role="menuitem"]')).toEqual({
    low: null, warm: null, high: { pressure: 'danger', text: '90%' }, unknown: null
  })
  expect(IDS.map(id => ({ id, control: current(id).control, processState: current(id).processState,
    state: current(id).status.state }))).toEqual(controlsBefore)
  for (const id of ['unknown', 'high']) {
    const ui = composer(id)
    const editor = ui.section.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(editor).not.toBeNull()
    expect(editor!.getAttribute('aria-disabled')).not.toBe('true')
    const draft = `Unsent draft for ${id}`
    await act(async () => {
      editor!.textContent = draft
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft }))
    })
    expect(useAppStore.getState().agentComposerDrafts[id]).toBe(draft)
  }
  expect(composer('unknown').chip.textContent).toContain('—')
  expect(composer('unknown').details.textContent).toContain('never an estimate from lifetime billing')
  expect(composer('high').chip.textContent).toContain('90%')
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(transport.calls).toEqual(['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
})

it('the published native usage is owned by the Store rather than its mutable incoming envelope', async () => {
  const event = publication('warm', nativeReading(700))
  await emit(event)
  if (event.event.type !== 'agent-session') throw new Error('Expected full AgentSession fixture')
  event.event.session.turnUsage!.context!.usedTokens = 999
  expect(current('warm').turnUsage?.context).toEqual({ usedTokens: 700, capacityTokens: 1000 })
  expect(composer('warm').chip.textContent).toContain('70%')
})
