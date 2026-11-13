const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { renderComponentBoundary as captureComponentBoundary } from './helpers/render-component-boundary'
import { isValidElement, type ComponentProps, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { AgentComposerProps } from '@agentmux/client-ui/components/AgentComposer'
import type { ComposerCompletionEditorProps } from '@agentmux/client-ui/components/ComposerCompletionEditor'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const fixture = vi.hoisted(() => ({
  state: {
    sessions: [] as SessionSnapshot[], providerCatalog: [],
    agentComposerDrafts: {} as Record<string, string>, agentSteerQueues: {}, agentSteerInFlight: {}, noticeReadReceipts: {},
    // 手搭的 store 替身缺一个 slice 就抛 TypeError，而栈顶指向生产文件，看起来像组件回归。
    // `AgentSessionComposer` 读 `state.viewModes[sessionId]` 且**没有** `?.`（其余 slice 都有）。
    viewModes: {} as Record<string, 'terminal' | 'timeline'>,
    recordAgentComposerHistory: vi.fn(), recallAgentComposerHistory: vi.fn(() => null),
    setAgentComposerDraft: vi.fn(), clearAgentComposerDraftIfUnchanged: vi.fn(),
    enqueueAgentSteer: vi.fn(() => true), flushAgentSteerQueue: vi.fn(async () => {}),
    send: vi.fn(() => true), interrupt: vi.fn(), setPosture: vi.fn(), reportError: vi.fn()
  }
}))
vi.mock('../src/renderer/src/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/store')>()
  // Every slice this test does not name reads the real initial store, so a slice the component adds
  // later cannot redden every case with a TypeError that points into production code.
  Object.setPrototypeOf(fixture.state, actual.useAppStore.getState())
  return {
    ...actual,
    useAppStore: Object.assign(
      (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
      { getState: () => fixture.state }
    )
  }
})
// A shallow server render has no mounted Runtime subscription; Runtime reads are not this test's subject.
vi.mock('../src/renderer/src/lib/run-service-projection', () => ({ useRunService: () => undefined }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { ComposerCompletionEditor } from '@agentmux/client-ui/components/ComposerCompletionEditor'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'

/** Depth-first search of an already-built element tree; render-prop children are not invoked here. */
function findElement<Props>(node: unknown, type: unknown): ReactElement<Props> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = findElement<Props>(child, type); if (found) return found } return undefined }
  if (!isValidElement<{ children?: unknown }>(node)) return undefined
  if (node.type === type) return node as ReactElement<Props>
  return findElement<Props>(node.props.children, type)
}

/**
 * The adapter returns SessionMailbox and hands it the composer as a render prop. Invoke that prop
 * directly — it is plain JSX from the adapter's own closure — to reach the actual AgentComposer props
 * without server-rendering the mailbox's document-bound hooks, which are not this test's subject.
 */
function renderComponentBoundary(Component: typeof AgentSessionComposer, props: ComponentProps<typeof AgentSessionComposer>): ReactElement<AgentComposerProps> {
  const mailbox = captureComponentBoundary(Component, props)
  if (mailbox.type !== SessionMailbox) throw new Error('Expected the actual SessionMailbox adapter boundary')
  const render = (mailbox.props as ComponentProps<typeof SessionMailbox>).children
  if (typeof render !== 'function') throw new Error('Expected SessionMailbox to receive the composer render prop')
  const composer = findElement<AgentComposerProps>(render(null, null, { current: null } as never), AgentComposer)
  if (!composer) throw new Error('Expected the render prop to contain the actual AgentComposer')
  return composer
}

afterEach(() => { vi.clearAllMocks() })

function input(state: 'waiting' | 'blocked' | 'running', pending: boolean, suffix = '') {
  const id = `${state}-${pending}-${suffix}`
  fixture.state.sessions = [{
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: _hygiene_fixturePath("repo"), label: 'Agent', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 1 }, processState: 'running',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'run' } },
    ...(pending ? { pendingInteraction: { id: 'question' } } : {})
  } as Extract<SessionSnapshot, { kind: 'agent' }>]
  fixture.state.agentComposerDrafts = { [id]: 'keep this thought' }
  // Follow both production components to the actual handler passed to the rich input.
  const surface = renderComponentBoundary(AgentSessionComposer, { sessionId: id })
  const composer = AgentComposer(surface.props as AgentComposerProps)
  // The rich editor's own key handler; suggestions are closed, so every key reaches the composer's intent.
  const editor = findElement<ComposerCompletionEditorProps>(composer, ComposerCompletionEditor)
  if (!editor) throw new Error('Expected AgentComposer to render the actual completion editor')
  expect(editor.props.disabled).toBe(false)
  return { id, keyDown: (event: KeyboardEvent, caret: number) => editor.props.onKeyDown(event, caret, true, false) }
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
      expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought', expect.any(Function), undefined, 'manual', undefined, expect.any(Object))
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
    expect(fixture.state.send).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought', expect.any(Function), 'manual', undefined, expect.any(Object))
    expect(fixture.state.enqueueAgentSteer).not.toHaveBeenCalled()
    expect(fixture.state.clearAgentComposerDraftIfUnchanged).toHaveBeenCalledExactlyOnceWith(id, 'keep this thought')
  })
})
