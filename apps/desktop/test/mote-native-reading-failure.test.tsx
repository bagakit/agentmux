// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface, installNativePopover } from './fixtures/mote-workface'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Only native terminal transport is controlled. Actual App, ActivityView,
// Mote readers, Workbench, SessionPane and Composer stay in the consumer chain.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) => <div data-terminal-session={session.id} /> }))
const baseline = useAppStore.getState(), closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true); localStorage.clear() })
it.each([
  ['unavailable', 'working'], ['complete-events', 'waiting'], ['complete-events', 'working']
] as const)('initial Native failure keeps the actual Mote dialogue/dispatch and original input (%s/%s)', async (capability, state) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) }
    unobserve() {} disconnect() {}
  })
  localStorage.clear(); seedMoteWorkface(); closes.push(installNativePopover())
  const launch = vi.fn(), send = vi.fn(), stop = vi.fn()
  useAppStore.setState(current => ({ loading: false, initialize: async () => () => {}, activeWorkspaceId: scratchWorkspace.id, mainSurface: 'workbench',
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}), launchAgent: launch, send, stopSession: stop,
    sessions: current.sessions.map(session => session.id !== defaultAgent.id ? session : { ...defaultAgent,
      capabilities: { ...defaultAgent.capabilities, timeline: capability }, status: { ...defaultAgent.status, state } }),
    viewModes: { [defaultAgent.id]: 'activity' } }))
  useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', defaultTab.id)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  const native = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(new Error('Original native reader failed before its first accepted window'))
  vi.spyOn(api.conversation, 'observeConversation').mockRejectedValue(new Error('Original native observation unavailable'))
  const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }): Promise<MoteDialoguePage> => ({
    main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-MOTE', roleRevision: 'original-role', current: reference, issue: null },
    links: [{ sequence: 1, kind: 'work', identity: { hostId: 'local', moteId: moteTopics[0]!.id }, operationId: 'original-work-link', associatedAt: 1,
      eventId: 'original-work-event', mainRoleRevision: 'original-role', main: { hostId: 'local', agentSessionId: defaultAgent.id },
      origin: { hostId: 'local', messageId: 'original-dispatch', threadId: 'original-thread', senderSessionId: defaultAgent.id, recipientSessionId: 'neighbor-agent', createdAt: 1 } }],
    incarnation: 'original-links', throughSequence: 1, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null
  }))
  const dispatch = vi.spyOn(api.sessions, 'dispatch').mockResolvedValue({ hostId: 'local', dispatch: { sourceMessageId: 'original-dispatch', ownerAgentSessionId: defaultAgent.id,
    workerAgentSessionId: 'neighbor-agent', threadId: 'original-thread', openedAt: 1, originAwaits: true, events: [] },
    source: { envelope: { messageId: 'original-dispatch', threadId: 'original-thread', senderSessionId: defaultAgent.id, recipientSessionId: 'neighbor-agent', createdAt: 1, body: 'Read the original healthy work thread' } },
    replies: [{ envelope: { messageId: 'original-reply', senderSessionId: 'neighbor-agent', body: 'Original dispatch reply remains readable', createdAt: 2 } }], identityDiagnostics: [] } as any)
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  closes.push(async () => { await act(async () => root.unmount()); container.remove() })
  const retained = useAppStore.getState()
  await act(async () => root.render(<App />))
  await vi.waitFor(() => expect(native).toHaveBeenCalled())
  await vi.waitFor(() => expect(container.querySelector('.mote-conversation__navigation')).not.toBeNull())
  const reader = container.querySelector('.activity-feed[data-mote-conversation="true"]')!, composer = container.querySelector('[aria-label="Message Agent"]')!
  expect(reader).not.toBeNull(); expect(composer).not.toBeNull(); expect(composer.getAttribute('contenteditable')).not.toBe('false'); expect(composer.getAttribute('aria-disabled')).not.toBe('true')
  expect(reader.textContent).toContain('主对话记录的切点尚未读到')
  const history = [...reader.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '事件历史 · 1')!
  await act(async () => history.click())
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: defaultAgent.id }, 'original-dispatch'))
  const card = reader.querySelector<HTMLButtonElement>('.mote-conversation__history .mote-work-event__summary')!
  await act(async () => card.click())
  await vi.waitFor(() => expect(reader.querySelector('.mote-conversation__history')?.textContent).toContain('Original dispatch reply remains readable'))
  expect(reader.querySelector('.mote-conversation__history')?.textContent).toContain('Read the original healthy work thread')
  expect(container.querySelector('.activity-feed[data-mote-conversation="true"]')).toBe(reader); expect(container.querySelector('[aria-label="Message Agent"]')).toBe(composer)
  expect(useAppStore.getState().tabs).toBe(retained.tabs); expect(useAppStore.getState().layouts).toBe(retained.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(retained.agentComposerDrafts); expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
