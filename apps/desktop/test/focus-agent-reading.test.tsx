// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, regionIds } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusContextMenu } from '../src/renderer/src/components/FocusContextMenu'
import { FocusAgentWorkspaceMenu } from '../src/renderer/src/components/FocusAgentWorkspaceMenu'
import { createFocusProjectionSelector, agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { focusAgentMenuLocation, requireFocusAgentMenuLocation } from '../src/renderer/src/lib/focus-agent-menu-location'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => <span /> }))
const initial = useAppStore.getState()
const target = { ...composerSession('presentation-target'), control: { ...composerSession('presentation-target').control, agentSessionId: 'canonical-target' } }
const peer = composerSession('peer')
const tab = createWorkbenchTab('target-tab', { kind: 'agent', phase: 'attached', regionId: 'target-region', workspaceId: 'workspace', sessionId: target.id })
let root: Root, host: HTMLDivElement
const closes: Array<() => unknown | Promise<unknown>> = []
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
function Scene() {
  const selector = useMemo(createFocusProjectionSelector, []), { contexts } = useAppStore(selector)
  return <>{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)}<input aria-label="Later work" /></>
}
async function open() {
  const card = host.querySelector<HTMLButtonElement>(`[data-session-id="${target.id}"]`)!
  await act(async () => { card.focus(); card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })) }); await settle()
  expect(document.querySelector('.focus-context-menu')).not.toBeNull()
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label)
  expect(item, `Real Focus menu item ${label}`).toBeTruthy()
  await act(async () => item!.click()); await settle()
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [peer, target], agentNames: { [peer.id]: 'Same Agent', [target.id]: 'Same Agent' },
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('target-group', [tab.id]) }, spaceZoneBindings: {}, scratchTopicSnapshots: {},
    mainSurface: 'agents', activeWorkspaceId: 'workspace', timelines: {}, agentComposerDrafts: { [target.id]: 'Unsent original draft', [peer.id]: 'Peer draft' },
    agentFocus: { execution: { sessionId: peer.id, history: [] }, pmo: { sessionId: null } } }, true)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); for (const close of closes.splice(0).reverse()) await close(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('real Focus action opens the original shared Reader with canonical host/SID only on demand and releases it on close', async () => {
  // Darwin's Unix socket limit applies to the private RPC fixture too. Keep its
  // own temp root short even when the mutation runner owns a nested cache root.
  vi.stubEnv('TMPDIR', fixturePath('tmp'))
  const fixture = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'original-answer', sessionId: 'native-main', message: { role: 'assistant', content: 'Original canonical conversation' } }]), { agentSessionId: target.control.agentSessionId })
  closes.push(fixture.close); await desktopConversationReadBridge(fixture, closes)
  await act(async () => root.render(<Scene />))
  expect(api.conversation.readAgentConversation).not.toHaveBeenCalled()
  await open(); expect(api.conversation.readAgentConversation).not.toHaveBeenCalled()
  const before = useAppStore.getState()
  await choose('Conversation history')
  await waitForAgentCardReading(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original canonical conversation'))
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.every(([input]) => input.hostId === target.control.hostId && input.agentSessionId === target.control.agentSessionId)).toBe(true)
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'agentFocus', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close Conversation history"]')!.click()); await settle()
  expect(api.conversation.releaseConversationView).toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('Focus passes the exact source to the original learning surface without extracting or sending on open', async () => {
  const call = vi.spyOn(api.agentLearning, 'call').mockRejectedValue(new Error('Private original operation listing unavailable'))
  await act(async () => root.render(<Scene />)); await open(); expect(call).not.toHaveBeenCalled()
  await choose('Pass on experience')
  expect(document.querySelector('[aria-label="Review Agent experience"]')).toBeTruthy()
  expect(call).toHaveBeenCalledExactlyOnceWith('agent.learning.ls', { hostId: target.control.hostId, agentSessionId: target.control.agentSessionId })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Private original operation listing unavailable')
})

it('closed cards add no Store observer, reader or hidden SessionPane', async () => {
  const subscribe = vi.spyOn(useAppStore, 'subscribe'), read = vi.spyOn(api.conversation, 'readAgentConversation')
  const context = agentContextForSession(target, undefined, 'Same Agent', composerConfig.workspaces[0], null)
  await act(async () => root.render(<FocusContextMenu context={context} open={false} onOpenChange={() => {}} onRename={() => {}} onRestoreFocus={() => {}}><button>Original card</button></FocusContextMenu>))
  expect(subscribe).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(host.querySelector('.agent-surface')).toBeNull()
  await act(async () => useAppStore.setState({ sessions: [peer, { ...target, updatedAt: 200 }] }))
  expect(read).not.toHaveBeenCalled(); expect(host.textContent).toBe('Original card')
})

it('the actual Focus split changes only its exact Tab using the existing layout owner', async () => {
  const neighbor = createWorkbenchTab('peer-tab', { kind: 'agent', phase: 'attached', regionId: 'peer-region', workspaceId: 'workspace', sessionId: peer.id })
  useAppStore.setState({ tabs: { [neighbor.id]: neighbor, [tab.id]: tab } })
  await act(async () => root.render(<Scene />)); await open()
  expect(document.querySelector('[aria-label="Copy Region Link"]')).toBeTruthy()
  const before = useAppStore.getState(); await choose('Split Right')
  const after = useAppStore.getState()
  expect(regionIds(after.tabs[tab.id]!.layout.root)).toHaveLength(2)
  expect(after.tabs[neighbor.id]).toBe(before.tabs[neighbor.id]); expect(after.tabs[tab.id]!.regions['target-region']).toBe(before.tabs[tab.id]!.regions['target-region'])
  for (const key of ['sessions', 'agentComposerDrafts', 'agentFocus', 'timelines'] as const) expect(after[key]).toBe(before[key])
})

it('multiple occurrences never choose the first Tab and stale Region/Run callbacks reject only that operation', async () => {
  const second = createWorkbenchTab('second-tab', { kind: 'agent', phase: 'attached', regionId: 'second-region', workspaceId: 'workspace', sessionId: target.id })
  useAppStore.setState({ tabs: { [second.id]: second, [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('target-group', [second.id, tab.id]) } })
  const location = focusAgentMenuLocation(useAppStore.getState(), target)
  expect(location.references).toHaveLength(2); expect(location.reference).toBeUndefined()
  await act(async () => root.render(<Scene />)); await open()
  expect(document.querySelector('[aria-label="Copy Region Link"]')).toBeNull()
  expect(document.querySelector('.focus-context-menu')?.textContent).toContain('Choose the exact work surface')
  const chosen = location.references.find(item => item.regionId === 'target-region')!
  expect(requireFocusAgentMenuLocation(useAppStore.getState(), target, chosen).reference).toEqual(chosen)
  await act(async () => useAppStore.setState({ sessions: [peer, { ...target, control: { ...target.control, run: { runId: 'new-run' } } }] }))
  expect(() => requireFocusAgentMenuLocation(useAppStore.getState(), target, chosen)).toThrow('Run changed')
  expect(useAppStore.getState().agentComposerDrafts[target.id]).toBe('Unsent original draft')
})

it('a captured location whose Tab disappeared keeps the original Agent and a readable menu', async () => {
  const { references } = focusAgentMenuLocation(useAppStore.getState(), target)
  expect(references).toHaveLength(1)
  const before = useAppStore.getState()
  useAppStore.setState({ tabs: {} })
  await act(async () => root.render(<ContextMenu.Root><ContextMenu.Trigger>Original location</ContextMenu.Trigger>
    <ContextMenu.Content><FocusAgentWorkspaceMenu target={target} references={references} issue={null} /></ContextMenu.Content>
  </ContextMenu.Root>))
  await expect(act(async () => { host.querySelector<HTMLElement>('[data-state]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })) })).resolves.toBeUndefined()
  await settle()
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('This work surface changed')
  expect(document.querySelector('[aria-label="Split Right"]')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
