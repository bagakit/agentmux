// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { formatMoteAddress, formatAmuxObjectLink } from '@agentmux/core/sharing'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MoteDialogueRead, MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { createClientUiRoot } from './helpers/client-ui-render'
import { seedMoteWorkface, scratchWorkspace, moteTopics, defaultAgent, defaultTab } from './fixtures/mote-workface'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SpaceObjectContextMenu } from '../src/renderer/src/components/SpaceObjectContextMenu'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'

let root: Root, host: HTMLDivElement, spaceId: string
let reads: ReturnType<typeof vi.spyOn>, copy: ReturnType<typeof vi.spyOn>, open: ReturnType<typeof vi.spyOn>
const original = useAppStore.getState()
const current = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const source = (input: MoteDialogueRead): MoteDialoguePage => ({
  main: { target: input.target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null,
    documentRevision: 'doc', roleRevision: 'role', current, issue: null },
  links: input.eventId ? [{ kind: 'work', sequence: 1, identity: { hostId: 'local', moteId: moteTopics[0]!.id },
    operationId: 'work-op', associatedAt: 1, eventId: input.eventId, mainRoleRevision: 'role',
    main: { hostId: 'local', agentSessionId: defaultAgent.id }, origin: { hostId: 'local', messageId: 'original-message',
      threadId: 'original-thread', senderSessionId: defaultAgent.id, recipientSessionId: 'neighbor-agent', createdAt: 1 } }] : [],
  incarnation: 'sources', throughSequence: 1, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface()
  spaceId = originalTopicAddress(scratchWorkspace, moteTopics[0]!, useAppStore.getState().spaceZoneBindings)!.spaceId
  useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: {
    ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics: moteTopics.map((topic, index) => index ? topic : { ...topic, title: '小脏手' })
  } } }))
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) {
    this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  } disconnect() {} unobserve() {} })
  reads = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => source(input))
  copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  document.querySelector('#agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(original, true)
})
const render = async (text: string) => act(async () => root.render(<ConversationMessage speaker={{ role: 'human', id: 'human' }} content={text} />))
const refs = () => [...host.querySelectorAll<HTMLElement>('[data-mote-link]')]
const click = async (element: HTMLElement) => act(async () => element.click())
const focus = async (element: HTMLElement) => act(async () => { element.focus(); await Promise.resolve() })

it('renders persistent Mote and exact thread references through the shared product adapter without reads, navigation or author changes', async () => {
  const uri = formatMoteAddress({ spaceId }), thread = formatMoteAddress({ spaceId, eventId: 'original/event' })
  const before = useAppStore.getState()
  await render(uri + ' [' + '审核任务' + '](' + thread + ') ' + uri + ' amux://agent/' + defaultAgent.id)
  expect(refs()).toHaveLength(3)
  expect(refs().map(node => node.dataset.moteReferenceKind)).toEqual(['main', 'thread', 'main'])
  expect(refs()[1]!.textContent).toContain('小脏手 · 审核任务')
  expect(host.querySelectorAll('[data-agent-link]')).toHaveLength(1)
  expect(host.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human')
  expect(reads).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  await click(refs()[1]!.querySelector<HTMLButtonElement>('button')!)
  expect(open).toHaveBeenCalledExactlyOnceWith(thread)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('shares exact scoped thread reads across repeated disclosures and copies the unchanged original URI', async () => {
  const eventId = 'original-scoped-event', uri = formatMoteAddress({ spaceId, eventId })
  await render(uri + ' ' + uri)
  await focus(refs()[0]!.querySelector<HTMLButtonElement>('button')!)
  await vi.waitFor(() => expect(document.querySelector('.mote-reference__details')?.textContent).toContain('neighbor-agent'))
  expect(reads).toHaveBeenCalledOnce()
  expect(reads.mock.calls[0]![0]).toMatchObject({ target: { spaceId }, kind: 'work', eventId })
  const details = document.querySelector<HTMLElement>('.mote-reference__details')!
  const copyButton = [...details.querySelectorAll('button')].find(button => button.textContent === '复制链接')!
  await click(copyButton); expect(copy).toHaveBeenCalledExactlyOnceWith(uri)
  await focus(refs()[1]!.querySelector<HTMLButtonElement>('button')!)
  await vi.waitFor(() => expect(document.querySelector('.mote-reference__details')?.textContent).toContain(eventId))
  expect(reads).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
})

it('keeps an unknown exact Mote reference operable without borrowing an observed Mote or reading another source', async () => {
  const uri = formatMoteAddress({ spaceId: 'unknown-original-space' })
  const error = new Error('Original target unavailable'), report = vi.fn()
  useAppStore.setState({ reportError: report }); open.mockRejectedValue(error)
  await render(uri)
  expect(refs()).toHaveLength(1)
  await focus(refs()[0]!.querySelector<HTMLButtonElement>('button')!)
  await vi.waitFor(() => expect(document.querySelector('.mote-reference__details')?.textContent).toContain('资料尚未确认'))
  expect(reads).not.toHaveBeenCalled()
  await click(refs()[0]!.querySelector<HTMLButtonElement>('button')!)
  expect(open).toHaveBeenCalledExactlyOnceWith(uri); expect(report).toHaveBeenCalledExactlyOnceWith(error)
})

it('retains code and read-only text and never recognizes a Host query as a different Mote identity', async () => {
  const uri = formatMoteAddress({ spaceId })
  await act(async () => root.render(<AgentMarkdown content={'`' + uri + '` ' + uri + '?host=other'} />))
  expect(refs()).toHaveLength(0)
  await act(async () => root.render(<AgentMarkdown content={uri} readOnly />))
  expect(refs()).toHaveLength(0); expect(host.textContent).toBe(uri)
  expect(reads).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
})


it('copies the persistent Mote address from the original object menu without opening or creating anything', async () => {
  const target = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!, useAppStore.getState().spaceZoneBindings)!
  await act(async () => root.render(<SpaceObjectContextMenu target={target}><button type="button" data-original-mote>小脏手</button></SpaceObjectContextMenu>))
  const trigger = host.querySelector<HTMLElement>('[data-original-mote]')!
  await act(async () => trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 30 })))
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Copy Mote link')
  expect(item).toBeDefined()
  await click(item!)
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatMoteAddress({ spaceId }))
  expect(open).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled()
})

it('does not rescan the Mote directory or open source reads for unrelated Session output updates', async () => {
  const directory = useAppStore.getState().scratchTopicSnapshots[scratchWorkspace.id]!.topics!
  const traverse = vi.spyOn(directory, 'flatMap')
  const uri = formatMoteAddress({ spaceId })
  await render(uri + ' ' + uri)
  expect(traverse).toHaveBeenCalled(); traverse.mockClear()
  for (let revision = 1; revision <= 12; revision++) await act(async () => useAppStore.setState(state => ({
    sessions: state.sessions.map(session => session.id === 'execution-agent' ? { ...session, latestOutputBytes: revision } : session)
  })))
  expect(traverse).not.toHaveBeenCalled()
  expect(reads).not.toHaveBeenCalled()
  expect(refs()).toHaveLength(2)
  expect(refs()[0]!.textContent).toContain('小脏手')
})

it('keeps an address-only reference unknown locally while its original link remains actionable', async () => {
  const uri = formatAmuxObjectLink({ kind: 'mote', address: { runtimeId: 'original-link-runtime', linkId: mintObjectId() } })
  useAppStore.setState(state => ({ spaceZoneBindings: {}, scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics: [{ ...moteTopics[0]!,
      title: 'Unconfirmed local identity', readError: 'Original directory unavailable', identityDirectoryPath: undefined }] }
  } }))
  await render(uri)
  expect(refs()).toHaveLength(1)
  const reference = refs()[0]!
  expect(reference.textContent).not.toContain('Unconfirmed local identity')
  expect(reads).not.toHaveBeenCalled()
  await focus(reference.querySelector<HTMLButtonElement>('button')!)
  await vi.waitFor(() => expect(document.querySelector('.mote-reference__details')?.textContent).toContain('原 Mote 资料尚未确认'))
  expect(reads).not.toHaveBeenCalled()
  await click(reference.querySelector<HTMLButtonElement>('button')!)
  expect(open).toHaveBeenCalledExactlyOnceWith(uri)
})
