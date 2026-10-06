// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { useComposerInputHistory } from '../src/renderer/src/lib/use-composer-input-history'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const sid = 'original-agent'
const control = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-run' } } as const
const message: AgentSessionUserMessage = {
  id: 'captured:original', rawId: 'original', agentSessionId: sid,
  source: { kind: 'captured', submissionId: 'original' }, author: { kind: 'human' },
  content: 'original historical body', contentParts: [{ kind: 'text', text: 'original historical body' }]
}
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
let view: ReturnType<typeof useComposerInputHistory>
const replace = vi.fn((text: string) => useAppStore.getState().setAgentComposerDraft(sid, text))
const insertion: { current: ComposerInsertionHandle } = { current: { replace, insert: async () => {} } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  useAppStore.setState({ agentComposerDrafts: { [sid]: 'unfinished original' }, agentComposerHistory: {}, agentComposerHistoryNavigation: {} })
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  replace.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function Probe() {
  view = useComposerInputHistory({ sessionId: sid, control, visible: true, readOnly: false, insertion })
  return null
}
async function mount(element: ReactNode = <Probe />) { await act(async () => root.render(element)) }
function fill() { return view.render(() => null).props.onFill!(message) }

it('the current Agent can fill an unchanged draft through the original insertion handle', async () => {
  await mount()
  await act(async () => { await fill() })
  expect(replace).toHaveBeenCalledExactlyOnceWith(message.content)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(message.content)
})

it('a newer draft in the helper-to-writer microtask gap survives late history completion', async () => {
  await mount()
  await act(async () => {
    const action = fill()
    queueMicrotask(() => useAppStore.getState().setAgentComposerDraft(sid, 'newer independently edited draft'))
    await expect(action).rejects.toThrow('新稿已保留')
  })
  expect(replace).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('newer independently edited draft')
})

it('a foreign Host and Agent page is rejected by the bound Desktop reader without changing its draft', async () => {
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (_reference, input): Promise<AgentSessionHistoryReadPage> => ({
    hostId: 'foreign-host', agentSessionId: 'neighbor-agent', source: input.source,
    revision: 'foreign', availability: 'available', order: 'newest-first', items: [],
    nextCursor: null, budgetBytes: 128 * 1024, kind: 'user-message',
    userMessages: [{ ...message, id: 'captured:foreign', agentSessionId: 'neighbor-agent' }],
    scan: { examined: 1, complete: true }
  }))
  await mount()
  await act(async () => view.setFocused(true))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const pages = view.render(() => null).props.history.pages
    expect(pages).toHaveLength(2)
    expect(pages.every(page => page.error?.includes('不属于当前 Agent'))).toBe(true)
  })
  expect(view.messages).toEqual([])
  expect(replace).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('unfinished original')
})
