// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'

vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
const initial = useAppStore.getState(), closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function until(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'original-answer', sessionId: 'native-main',
    message: { role: 'assistant', content: 'Original answer with **selected words** remains readable.' } }]))
  closes.push(f.close)
  const port = await desktopConversationReadBridge(f, closes)
  const bindingReads = vi.spyOn(api.connections, 'call').mockImplementation(async method => {
    if (method === 'connection.binding.ls') return { bindings: [] } as never
    throw new Error('Unexpected connection mutation in reading-only scenario: ' + method)
  })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: f.root })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  const agent = { ...composerSession(f.session.agentSessionId, 'claude'), workspacePath: f.root, nativeHandle: f.session.nativeHandle!,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  const tab = createWorkbenchTab('reading-tab', { regionId: 'reading-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: agent.id })
  const layout = { root: { type: 'leaf' as const, groupId: 'reading-group' }, groups: [{ id: 'reading-group', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'reading-group' }
  useAppStore.setState({ loading: false, config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] },
    sessions: [agent], tabs: { [tab.id]: tab }, layouts: { workspace: layout }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    viewModes: { [agent.id]: 'activity' }, agentNames: { [agent.id]: 'Original Agent' }, agentComposerDrafts: { [agent.id]: 'Original unsent draft 中' },
    pendingAgentLaunches: {}, recoveryCandidates: [], timelines: {}, agentSteerQueues: {}, agentSteerInFlight: {}, noticeReadReceipts: {} })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const feed = () => host.querySelector<HTMLElement>('.activity-feed')!
  const sample = () => inspectConversationConsumers({ hostId: 'local', agentSessionId: agent.id }).consumers.find(value => !value.viewport.hidden)
  const unchanged = async () => {
    expect(useAppStore.getState().sessions).toEqual([agent]); expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    expect(useAppStore.getState().layouts.workspace).toEqual(layout)
    expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original unsent draft 中')
    expect(host.querySelector('[role="textbox"]')?.getAttribute('contenteditable')).toBe('true')
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    expect(bindingReads.mock.calls.map(([method]) => method)).toEqual(['connection.binding.ls'])
  }
  return { f, port, agent, host, feed, sample, unchanged, render: () => act(async () => root.render(<WorkspaceWorkbench workspaceId="workspace" />)) }
}
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!

it('the actual Workbench presents one complete initial reading failure and retries both exact read owners without touching input or Run', async () => {
  const h = await fixture(), raw = 'RPC connection failed; its business outcome is unconfirmed.'
  let failed = true, attempts = 0
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    attempts++
    if (failed) throw new Error(raw + ' Original read ' + attempts)
    return h.port.readAgentConversation(...args)
  })
  await h.render()
  await until(() => { expect(h.feed()?.querySelectorAll('.full-page-loading--failed')).toHaveLength(1); expect(button(h.feed(), 'Retry reading')).toBeDefined() })
  expect(h.feed().querySelectorAll('.activity-feed__read-notice')).toHaveLength(0)
  expect(h.feed().querySelectorAll('button')).not.toHaveLength(0)
  expect([...h.feed().querySelectorAll('button')].filter(node => node.textContent?.trim() === 'Retry')).toHaveLength(0)
  expect(h.feed().textContent).toContain('Original read 1'); expect(h.feed().textContent).toContain('Original read 2')
  expect(h.feed().textContent).not.toContain('Retry the source above')
  const before = attempts
  failed = false
  await act(async () => button(h.feed(), 'Retry reading').click())
  await until(() => { expect(h.feed().textContent).toContain('Original answer with'); expect(h.feed().querySelector('.full-page-loading--failed')).toBeNull(); expect(h.sample()?.loading).toBe(false) })
  expect(attempts - before).toBe(2)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.map(([input]) => ({ hostId: input.hostId, agentSessionId: input.agentSessionId }))).toEqual(Array.from({ length: reads.length }, () => ({ hostId: 'local', agentSessionId: h.agent.id })))
  await h.unchanged()
})

it('accepted conversation text and selection survive two source failures behind one compact disclosure', async () => {
  const h = await fixture()
  await h.render()
  await until(() => { expect(h.feed()?.querySelector('.log-turn__body strong')).not.toBeNull(); expect(h.sample()?.loading).toBe(false) })
  if (process.env['AGENTMUX_READING_VISUAL_FRAME']) {
    const frame = await h.port.readAgentConversation({ hostId: 'local', agentSessionId: h.agent.id, limit: 100 })
    expect(frame.window.complete).toBe(true)
    await writeFile(process.env['AGENTMUX_READING_VISUAL_FRAME'], JSON.stringify(frame))
  }
  const selected = h.feed().querySelector('.log-turn__body strong')!, range = document.createRange()
  range.selectNodeContents(selected); getSelection()!.addRange(range)
  let failed = true
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    if (failed) throw new Error('Original source read temporarily unavailable')
    return h.port.readAgentConversation(...args)
  })
  // Cover and re-open the same retained current surface: both original reader
  // consumers replay their accepted views and independently retain failures.
  await act(async () => useAppStore.getState().setViewMode(h.agent.id, 'terminal'))
  await act(async () => useAppStore.getState().setViewMode(h.agent.id, 'activity'))
  await until(() => expect(h.feed()?.querySelectorAll('[aria-label="View service notice: Conversation reading interrupted"]')).toHaveLength(1))
  expect(h.feed().querySelector('.full-page-loading--failed')).toBeNull()
  expect(h.feed().querySelectorAll('.activity-feed__read-notice')).toHaveLength(0)
  expect(selected.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(getSelection()!.toString()).toBe('selected words')
  expect(h.feed().textContent).toContain('Original source read temporarily unavailable')
  failed = false
  await act(async () => button(h.feed(), 'Retry reading').click())
  await until(() => expect(h.feed().querySelector('[aria-label="View service notice: Conversation reading interrupted"]')).toBeNull())
  expect(selected.isConnected).toBe(true); expect(getSelection()!.toString()).toBe('selected words')
  await h.unchanged()
})
