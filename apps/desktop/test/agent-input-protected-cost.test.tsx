// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryObservation } from '@agentmux/core'
import { AgentInputRecap } from '../src/renderer/src/components/AgentInputRecap'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import type { AgentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), agent = composerSession('protected-input-agent'), source = { providerId: 'codex', nativeSessionId: 'original-input-source' }
const workspace = composerConfig.workspaces[0]!
const captured = [1, 2, 3].map(index => ({ id: 'captured-' + index, agentSessionId: agent.id, kind: 'user_message' as const,
  source: 'user' as const, title: 'Original input', status: 'complete' as const, content: 'Original captured input ' + index, createdAt: index, updatedAt: index }))
const timeline = { agentSessionId: agent.id, revision: 1, items: captured }
const native = (text = 'Original in-flight native input') => ({ agentSessionId: agent.id, source, nextCursor: null,
  items: [{ id: 'native-original', kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text }] }] })
let conversation: Awaited<ReturnType<typeof agentCardConversationFixture>>, request: AgentInformationPreview
let notify: (observation: AgentSessionHistoryObservation) => void
const dispose = vi.fn()
const inputs = () => [...dom.container.querySelectorAll<HTMLElement>('[data-hover-input-id]')]
const tick = async () => { await act(async () => { await new Promise(done => setTimeout(done, 100)) }) }
const render = async (follow: boolean) => dom.render(<AgentInputRecap request={request} enabled available follow={follow} />)
beforeEach(async () => {
  useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, agentNames: {} })
  dispose.mockClear()
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ ...native(), items: [] })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_control, listener) => {
    notify = listener
    return { agentSessionId: agent.id, source, dispose }
  })
  conversation = await agentCardConversationFixture(() => source)
  request = { token: {}, id: 'protected-input-reading', context: agentContextForSession(agent, timeline, 'Original Agent', workspace, null),
    anchor: document.createElement('button'), keepOpen() {}, restoreFocus() {}, openWorkface() {}, session: agent, control: agent.control,
    sourceKey: 'original-input-source', enterReading: false, pinned: true, contentChanged: false,
    bookmark: { key: 'original-input-bookmark', hostId: 'local', agentSessionId: agent.id, presentationId: agent.id,
      label: 'Original Agent', workspaceName: workspace.name, bounds: { x: 0, y: 0, width: 400, height: 600 } } }
})

it('settles the original batch once, parks the accepted view and preserves DOM, Range and expanded input until explicit follow', async () => {
  const client = conversation.clientFor('local')
  let resolve!: (value: Awaited<ReturnType<typeof client.readSessionHistoryChanges>>) => void
  vi.mocked(client.readSessionHistoryChanges).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await render(true)
  await waitForAgentCardReading(() => { expect(inputs()).toHaveLength(3); expect(resolve).toBeTypeOf('function') })
  const original = inputs(), entry = original[0]!.querySelector<HTMLElement>('[role=button]')!
  await act(async () => entry.click())
  const expanded = dom.container.querySelector<HTMLElement>('[data-agent-input-reading]')!, prose = expanded.querySelector('p')!
  const range = document.createRange(); range.selectNodeContents(prose)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const selection = document.getSelection()!.toString()
  expanded.scrollTop = 61
  await render(false)
  expect(dispose).not.toHaveBeenCalled()
  expect(api.conversation.releaseConversationView).not.toHaveBeenCalled()
  await act(async () => resolve({ hostId: 'local', agentSessionId: agent.id, source, items: native().items,
    checkpoint: { agentSessionId: agent.id, source, cursor: 'original-input-next-cut' }, more: false }))
  await waitForAgentCardReading(() => expect(vi.mocked(api.conversation.readConversationChanges).mock.settledResults[0]?.type).toBe('fulfilled'))
  await tick()
  const firstFrame = await vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
  const accepted = await vi.mocked(api.conversation.readConversationChanges).mock.results[0]!.value
  expect(JSON.stringify(accepted.items)).toContain('Original in-flight native input')
  const reads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  expect(reads).toBe(1)
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      useAppStore.setState({ timelines: { [agent.id]: { ...timeline, revision: index + 2,
        items: [...captured, { ...captured[0]!, id: 'later-' + index, content: 'Later captured request ' + index, createdAt: 10 + index, updatedAt: 10 + index }] } } })
      await conversation.sync({ hostId: 'local', agentSessionId: agent.id })
      notify({ kind: 'invalidated', agentSessionId: agent.id, source })
    })
    await tick()
    expect(api.conversation.readConversationChanges).toHaveBeenCalledTimes(reads)
    expect(client.readSessionHistoryChanges).toHaveBeenCalledTimes(1)
  }
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(inputs()).toEqual(original)
  expect(dom.container.querySelector('[data-agent-input-reading]')).toBe(expanded)
  expect(expanded.scrollTop).toBe(61)
  expect(document.getSelection()!.getRangeAt(0)).toBe(range)
  expect(document.getSelection()!.toString()).toBe(selection)
  expect(dom.container.textContent).not.toContain('Original in-flight native input')
  expect(dom.container.textContent).not.toContain('Later captured request')
  expect(api.conversation.releaseConversationView).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Back to recent inputs"]')!.click())
  await render(true)
  await waitForAgentCardReading(() => expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(2))
  const resumed = vi.mocked(api.conversation.readAgentConversation).mock.calls[1]![0]
  expect(resumed).toMatchObject({ hostId: 'local', agentSessionId: agent.id, view: accepted.window.view })
  expect(accepted.window.id).toBe(firstFrame.window.id)
  await waitForAgentCardReading(() => expect(dom.container.textContent).toContain('Later captured request'))
  await tick()
  const followedReads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => notify({ kind: 'invalidated', agentSessionId: agent.id, source }))
  await waitForAgentCardReading(() => expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(followedReads))
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  await dom.render(null)
  await waitForAgentCardReading(() => expect(api.conversation.releaseConversationView).toHaveBeenCalled())
})

it('retains original source failure and captured inputs while parking, then retries the same view only after explicit follow', async () => {
  vi.mocked(api.sessions.historyPage).mockRejectedValue(new Error('Original native source is unavailable'))
  vi.mocked(conversation.clientFor('local').readSessionHistoryChanges).mockRejectedValue(new Error('Original native source remains unavailable'))
  await render(true)
  await waitForAgentCardReading(() => {
    expect(inputs()).toHaveLength(3)
    expect(dom.container.textContent).toContain('Recent message reading unavailable')
  })
  await tick()
  const frame = await vi.mocked(api.conversation.readConversationChanges).mock.results.at(-1)!.value, original = inputs()
  await render(false)
  await waitForAgentCardReading(() => expect(dispose).toHaveBeenCalled())
  const reads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  for (let index = 0; index < 3; index++) {
    await act(async () => notify({ kind: 'invalidated', agentSessionId: agent.id, source }))
    await tick()
  }
  expect(api.conversation.readConversationChanges).toHaveBeenCalledTimes(reads)
  expect(inputs()).toEqual(original)
  expect(dom.container.textContent).toContain('Recent message reading unavailable')
  expect(api.conversation.releaseConversationView).not.toHaveBeenCalled()
  await render(true)
  await waitForAgentCardReading(() => expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[1]![0]).toMatchObject({ hostId: 'local', agentSessionId: agent.id, view: frame.window.view })
  expect(inputs()).toEqual(original)
})
