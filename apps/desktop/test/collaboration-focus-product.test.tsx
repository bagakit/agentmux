// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const executionBindings = vi.hoisted(() => new Map<string, { hostId: string }>())
vi.mock('../src/renderer/src/store', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/store')>(), agentRegionExecution: (ref: { tabId: string; regionId: string }) => executionBindings.get(JSON.stringify([ref.tabId, ref.regionId])) ?? null }))
const dom = composerDOM({ agentInformation: true }), workspace = composerConfig.workspaces[0]!, session = composerSession('graph-agent'), peer = composerSession('graph-peer')
const ref = { displayWorkspaceId: workspace.id, groupId: 'graph-group', tabId: 'graph-tab', regionId: 'graph-region' }
const envelope = { messageId: 'graph-message', senderSessionId: session.control.agentSessionId, recipientSessionId: peer.control.agentSessionId, threadId: 'graph-thread', replyTo: null }
function Fixture() {
  const state = useAppStore()
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, spatialCatalog(state, []), () => {})
  return <GlobalFocusSurface presentation={presentation} onSelectContext={open} />
}
const open = vi.fn()
const graph = () => document.querySelector<HTMLElement>('.collaboration-dialog')!
async function click(label: string) { const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(button).toBeTruthy(); await act(async () => button.click()) }
beforeEach(() => {
  const tab = createWorkbenchTab(ref.tabId, { regionId: ref.regionId, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  const peerTab = createWorkbenchTab('graph-peer-tab', { regionId: 'graph-peer-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: peer.id })
  executionBindings.clear(); executionBindings.set(JSON.stringify([ref.tabId, ref.regionId]), { hostId: session.control.hostId }); executionBindings.set(JSON.stringify([peerTab.id, 'graph-peer-region']), { hostId: peer.control.hostId })
  useAppStore.setState({ config: composerConfig, sessions: [session, peer], tabs: { [tab.id]: tab, [peerTab.id]: peerTab }, layouts: { [workspace.id]: createWorkspaceLayout(ref.groupId, [tab.id, peerTab.id]) }, activeWorkspaceId: workspace.id, mainSurface: 'agents', agentNames: { [session.id]: 'Graph task', [peer.id]: 'Peer task' },
    timelines: {}, agentComposerDrafts: { [session.id]: 'Original graph draft' }, agentFocus: { execution: { sessionId: session.id, history: [], reference: ref }, pmo: { sessionId: null } } })
  open.mockReset()
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (reference, options): Promise<AgentMuxRpcResult<'message.events'>> => ({ ...reference, participantSessionId: reference.agentSessionId, afterSequence: options?.afterSequence ?? 0,
    latest: options?.latest ?? false, beforeSequence: options?.beforeSequence ?? null, throughSequence: 7, incarnation: 'graph-journal', messageId: options?.messageId ?? null, broadcastOperationId: null,
    events: [{ sequence: 7, kind: 'message', at: fixtureEpoch(1), messages: [envelope] }], nextAfterSequence: null, nextBeforeSequence: null }))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (reference, options) => ({ ...reference, participantSessionId: reference.agentSessionId, direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'readMessage').mockRejectedValue(Error('Deliberate original body unavailable'))
  vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('No body demand'))
})
it('opens the real Focus graph at the exact original subject and keeps the background workface and draft', async () => {
  await dom.render(createElement(Fixture))
  const before = useAppStore.getState(), workface = document.querySelector('.global-focus-layout')
  expect(api.sessions.messageEvents).not.toHaveBeenCalled()
  await click('Open Agent collaboration graph')
  await act(async () => vi.waitFor(() => expect(graph()?.textContent).toContain('1 connections')))
  expect(api.sessions.messageEvents).toHaveBeenCalledExactlyOnceWith({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, { latest: true, limit: 50 })
  expect(api.sessions.spawns).toHaveBeenCalledTimes(2)
  expect(graph().querySelector('.focus-context[data-session-id="graph-agent"]')).not.toBeNull()
  expect(graph().querySelector('.focus-context[data-session-id="graph-peer"]')).not.toBeNull()
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(document.querySelector('.global-focus-layout')).toBe(workface)
  await act(async () => graph().querySelector<HTMLButtonElement>('.focus-context[data-session-id="graph-peer"]')!.click())
  expect(open).not.toHaveBeenCalled()
  await act(async () => [...graph().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Open workface'))!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith(peer.id, { displayWorkspaceId: workspace.id, groupId: ref.groupId, tabId: 'graph-peer-tab', regionId: 'graph-peer-region' })
  expect(graph()).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original graph draft')
})
it('offers explicit source reading, keeps failure local and leaves healthy relations visible', async () => {
  await dom.render(createElement(Fixture)); await click('Open Agent collaboration graph')
  await act(async () => vi.waitFor(() => expect(graph()?.querySelector('.collaboration-relation')).not.toBeNull()))
  await act(async () => graph().querySelector<HTMLButtonElement>('.collaboration-relation')!.click())
  expect(graph().textContent).toContain('graph-message'); expect(api.sessions.readMessage).not.toHaveBeenCalled()
  await act(async () => [...graph().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read original message')!.click())
  await act(async () => vi.waitFor(() => expect(graph().textContent).toContain('Deliberate original body unavailable')))
  expect(api.sessions.readMessage).toHaveBeenCalledExactlyOnceWith({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, 'graph-message')
  expect(graph().querySelector('.focus-context[data-session-id="graph-agent"]')).not.toBeNull()
  await click('Close collaboration graph')
  const count = vi.mocked(api.sessions.messageEvents).mock.calls.length
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Other work' } }))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(count)
})

it('relation controls filter the actual canvas and inspector without changing input or Session state', async () => {
  await dom.render(createElement(Fixture)); await click('Open Agent collaboration graph')
  await act(async () => vi.waitFor(() => expect(graph()?.textContent).toContain('1 connections')))
  const original = useAppStore.getState().agentComposerDrafts
  const toggle = graph().querySelector<HTMLButtonElement>('.collaboration-toolbar__kinds [data-kind="communication"]')!
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('false'); expect(graph().textContent).toContain('0 connections')
  await act(async () => toggle.click())
  expect(graph().textContent).toContain('1 connections')
  expect(useAppStore.getState().agentComposerDrafts).toBe(original); expect(open).not.toHaveBeenCalled()
})

it('keeps an unconfirmed workface readable without navigating a same-SID location at another Host', async () => {
  executionBindings.set(JSON.stringify(['graph-peer-tab', 'graph-peer-region']), { hostId: 'other-host' })
  await dom.render(createElement(Fixture)); await click('Open Agent collaboration graph')
  await act(async () => vi.waitFor(() => expect(graph()?.querySelector('.focus-context[data-session-id="graph-peer"]')).not.toBeNull()))
  await act(async () => graph().querySelector<HTMLButtonElement>('.focus-context[data-session-id="graph-peer"]')!.click())
  await act(async () => [...graph().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Open workface'))!.click())
  expect(open).not.toHaveBeenCalled(); expect(graph().textContent).toContain('Original workface location is unconfirmed')
  expect(graph().querySelector('.focus-context[data-session-id="graph-peer"]')).not.toBeNull()
})
