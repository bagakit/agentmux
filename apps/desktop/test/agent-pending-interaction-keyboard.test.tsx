import { renderComponentBoundary } from './helpers/render-component-boundary'
import { Children, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { AgentComposerProps } from '../src/renderer/src/components/AgentComposer'
import type { InlineComposerProps } from '../src/renderer/src/components/InlineComposer'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[], providerCatalog: [],
    agentComposerDrafts: {} as Record<string, string>, agentSteerQueues: {}, agentSteerInFlight: {}, noticeReadReceipts: {},
    setAgentComposerDraft: vi.fn(), clearAgentComposerDraftIfUnchanged: vi.fn(),
    enqueueAgentSteer: vi.fn(() => true), flushAgentSteerQueue: vi.fn(async () => {}),
    send: vi.fn(() => true), interrupt: vi.fn(), setPosture: vi.fn(), reportError: vi.fn()
  }
}))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer'
import { InlineComposer } from '../src/renderer/src/components/InlineComposer'

afterEach(() => { vi.clearAllMocks() })

function input(state: 'waiting' | 'blocked' | 'running', pending: boolean, suffix = '') {
  const id = `${state}-${pending}-${suffix}`
  fixture.state.sessions = [{
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/repo', label: 'Agent', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 1 }, processState: 'running',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'run' } },
    ...(pending ? { pendingInteraction: { id: 'question' } } : {})
  } as Extract<SessionSnapshot, { kind: 'agent' }>]
  fixture.state.agentComposerDrafts = { [id]: 'keep this thought' }
  // Follow both production components to the actual handler passed to the rich input.
  const surface = renderComponentBoundary(AgentSessionComposer, { sessionId: id })
  const composer = AgentComposer(surface.props as AgentComposerProps)
  const editor = Children.toArray(composer.props.children)[0] as ReactElement<InlineComposerProps>
  expect(editor.type).toBe(InlineComposer)
  expect(editor.props.disabled).toBe(false)
  return { id, keyDown: editor.props.onKeyDown }
}

function enter(shiftKey = false) {
  const preventDefault = vi.fn()
  return {
    event: { key: 'Enter', shiftKey, metaKey: false, ctrlKey: false, isComposing: false, preventDefault } as unknown as KeyboardEvent,
    preventDefault
  }
}

describe('pending interaction queue keyboard path', () => {
  it.each([
    { isComposing: true }, { keyCode: 229 },
    { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }
  ])('the actual composer handler leaves IME-owned Enter untouched (%j)', (marker) => {
    const { keyDown } = input('running', false)
    const key = enter()
    keyDown(Object.assign(key.event, marker), 17)
    expect(key.preventDefault).not.toHaveBeenCalled()
    expect(fixture.state.send).not.toHaveBeenCalled()
    expect(fixture.state.enqueueAgentSteer).not.toHaveBeenCalled()
  })

  for (const state of ['waiting', 'blocked'] as const) {
    it(`${state}: Enter queues through the real input handler while immediate submission is gated`, () => {
      const { id, keyDown } = input(state, true)
      const key = enter()
      keyDown(key.event, 17)
      expect(key.preventDefault).toHaveBeenCalledOnce()
      expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought', expect.any(Function))
      expect(fixture.state.clearAgentComposerDraftIfUnchanged).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought')
      expect(fixture.state.flushAgentSteerQueue).toHaveBeenCalledExactlyOnceWith(id)
      expect(fixture.state.send).not.toHaveBeenCalled()
    })

    it(`${state}: Shift+Enter keeps editing without queueing or sending`, () => {
      const { keyDown } = input(state, true, 'newline')
      const key = enter(true)
      keyDown(key.event, 17)
      expect(key.preventDefault).not.toHaveBeenCalled()
      expect(fixture.state.enqueueAgentSteer).not.toHaveBeenCalled()
      expect(fixture.state.send).not.toHaveBeenCalled()
      expect(fixture.state.clearAgentComposerDraftIfUnchanged).not.toHaveBeenCalled()
    })
  }

  it('normal Enter still submits when no interaction or queue intent exists', () => {
    const { id, keyDown } = input('running', false)
    const key = enter()
    keyDown(key.event, 17)
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.state.send).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought', expect.any(Function))
    expect(fixture.state.enqueueAgentSteer).not.toHaveBeenCalled()
    expect(fixture.state.clearAgentComposerDraftIfUnchanged).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought')
  })
})
