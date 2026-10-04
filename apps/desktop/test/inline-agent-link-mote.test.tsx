// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { customAgent, defaultAgent, executionAgent, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

let root: Root, host: HTMLDivElement
const original = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface()
  const target = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!)!
  useAppStore.setState({ agentNames: { [executionAgent.id]: 'Named original Agent' },
    spaceObjectIcons: { [target.key]: 'brain' } })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  vi.restoreAllMocks(); useAppStore.setState(original, true)
})
async function mount(content: string) {
  await act(async () => root.render(<ConversationMessage content={content} speaker={{ role: 'agent', id: executionAgent.id }} />))
}
const ref = (id: string) => host.querySelector<HTMLElement>('[data-agent-link="amux://agent/' + id + '"]')!

it('renders global Mote identity through the actual shared message adapter and opens the same SID', async () => {
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  const before = useAppStore.getState()
  await mount(`References: amux://agent/${defaultAgent.id} amux://agent/${customAgent.id} amux://agent/${executionAgent.id}`)
  expect(ref(defaultAgent.id).textContent).toContain('Mote')
  expect(ref(defaultAgent.id).querySelector('[data-space-icon="brain"]')).not.toBeNull()
  expect(ref(customAgent.id).textContent).toContain(moteTopics[1]!.title)
  expect(ref(customAgent.id).querySelector('[data-space-icon-kind="mote"]')).not.toBeNull()
  expect(ref(executionAgent.id).textContent).toContain('Named original Agent')
  expect(ref(executionAgent.id).querySelector('[data-space-icon-kind="mote"]')).toBeNull()
  expect(ref(defaultAgent.id).querySelectorAll('button')).toHaveLength(1)
  expect(open).not.toHaveBeenCalled()
  await act(async () => ref(defaultAgent.id).querySelector<HTMLButtonElement>('button')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('amux://agent/' + defaultAgent.id)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('keeps Mote identity derivation out of status, output and unrelated Session updates', async () => {
  const find = vi.spyOn(moteTopics, 'find')
  await mount('Agent amux://agent/' + defaultAgent.id)
  expect(find).toHaveBeenCalled(); find.mockClear()
  for (let revision = 1; revision <= 4; revision++) {
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session =>
      session.id === defaultAgent.id ? { ...session, status: { ...session.status, state: revision % 2 ? 'waiting' : 'working', observedAt: revision } } : { ...session, latestOutputBytes: revision }),
    timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision, items: [] } } })))
  }
  expect(find).not.toHaveBeenCalled()
  expect(ref(defaultAgent.id).querySelector('[data-space-icon="brain"]')).not.toBeNull()
  await act(async () => useAppStore.setState(state => ({ spaceObjectIcons: { ...state.spaceObjectIcons,
    [topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!)!.key]: 'rocket' } })))
  expect(find).toHaveBeenCalled()
  expect(ref(defaultAgent.id).querySelector('[data-space-icon="rocket"]')).not.toBeNull()
})
