import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => ({
  session: undefined as SessionSnapshot | undefined,
  state: {
    sessions: [] as SessionSnapshot[],
    providerCatalog: [] as AgentCatalogEntry[],
    config: {
      workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' as const }]
    },
    lastActiveFileByWorkspace: { workspace: 'src/index.ts' } as Record<string, string>,
    agentComposerDrafts: {} as Record<string, string>,
    setAgentComposerDraft: vi.fn(),
    clearAgentComposerDraftIfUnchanged: vi.fn(),
    enqueueAgentSteer: vi.fn(),
    // Typed to the real store signature (`send(sessionId, text)`, store.ts:627) so `mock.calls[n][1]`
    // is the text argument rather than an index into an inferred empty tuple.
    send: vi.fn(async (_sessionId: string, _text: string) => {}),
    interrupt: vi.fn(async () => {}),
    setPosture: vi.fn(async () => {}),
    reportError: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

// The composer reaches for native capabilities (file picker, pasted-image persistence) that only the
// desktop shell provides; the module itself resolves a build-time constant, so it is stubbed here.
// Hoisted so a test can make one of them reject and assert where that failure surfaces.
const nativeApi = vi.hoisted(() => ({
  chooseFiles: vi.fn(async () => null as string[] | null),
  savePastedImage: vi.fn(async () => '/tmp/pasted.png')
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { ui: nativeApi }
}))

import {
  AgentSessionComposer,
  agentComposerAvailability
} from '../src/renderer/src/components/AgentSessionComposer.js'

// Errors cross the reportError seam as `unknown`; read them the way the store's banner does.
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentSession(overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 'agent-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'agent-1',
      run: { runId: 'run-1' }
    },
    ...overrides
  }
}

afterEach(() => {
  fixture.state.sessions = []
  fixture.state.providerCatalog = []
  fixture.state.agentComposerDrafts = {}
  fixture.state.send.mockClear()
  fixture.state.interrupt.mockClear()
  fixture.state.setPosture.mockClear()
  fixture.state.setAgentComposerDraft.mockClear()
  fixture.state.clearAgentComposerDraftIfUnchanged.mockClear()
  fixture.state.enqueueAgentSteer.mockClear()
  fixture.state.reportError.mockClear()
  nativeApi.chooseFiles.mockClear()
  nativeApi.savePastedImage.mockClear()
  nativeApi.chooseFiles.mockImplementation(async () => null)
  nativeApi.savePastedImage.mockImplementation(async () => '/tmp/pasted.png')
})

// A minimal grok-shaped catalog entry carrying only the fields the composer reads plus the DESCRIBE-half
// posture control. The keystrokes stay in core; only these labels/tiers ever reach the renderer.
function postureCatalogEntry(): AgentCatalogEntry {
  return {
    id: 'grok',
    label: 'Grok',
    executable: 'grok',
    expectedProcess: 'grok',
    promptDelivery: 'positional-argv',
    readySignal: { kind: 'foreground-process', expectedProcess: 'grok' },
    hookStrategy: { kind: 'none' },
    resumeStrategy: { kind: 'none' },
    acpStrategy: { kind: 'none' },
    capabilities: {
      terminal: true,
      timeline: 'unavailable',
      permission: 'none',
      providerResume: false,
      replyCorrelation: 'none'
    },
    launchOptions: [],
    postureControl: {
      id: 'approval',
      label: 'Approvals',
      modes: [
        { id: 'ask', label: 'Ask each time', tier: 'safe' },
        { id: 'always-approve', label: 'Auto-approve', tier: 'danger' }
      ]
    }
  }
}

describe('AgentSessionComposer adapter', () => {
  it('binds a running Agent and current file to the reusable Composer', () => {
    fixture.state.sessions = [agentSession()]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Ask, steer, or paste a command…"')
    expect(markup).toContain('index.ts')
    expect(markup).not.toMatch(/<textarea[^>]*disabled=""/)
  })

  it('projects a Browser context handoff from the shared per-session draft', () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Browser element context\nSelector: main > button' }

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('Browser element context')
    expect(markup).toContain('Selector: main &gt; button')
  })

  it('submits and compare-clears the exact shared draft snapshot', async () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Browser element context' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit(): void }
    }

    composer.props.onSubmit()

    await vi.waitFor(() => {
      expect(fixture.state.send).toHaveBeenCalledWith('agent-1', 'Browser element context')
      expect(fixture.state.clearAgentComposerDraftIfUnchanged)
        .toHaveBeenCalledWith('agent-1', 'Browser element context')
    })
  })

  it('keeps the shared draft when prompt submission fails', async () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Retry this context' }
    fixture.state.send.mockRejectedValueOnce(new Error('submit failed'))
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit(): void }
    }

    composer.props.onSubmit()

    await vi.waitFor(() => expect(fixture.state.send).toHaveBeenCalledOnce())
    expect(fixture.state.clearAgentComposerDraftIfUnchanged).not.toHaveBeenCalled()
  })

  it('queues a working Agent message instead of risking readiness failure', () => {
    fixture.state.sessions = [agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } })]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Actually, edit the other file' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as { props: { onQueue?: () => void } }
    expect(composer.props.onQueue).toBeTypeOf('function')
    composer.props.onQueue?.()
    expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledWith('agent-1', 'Actually, edit the other file')
  })

  it('clears the draft when a message enters the queue, so entering is observable', () => {
    // The observability gap: onQueue used to leave the text in the box while only a number ticked up —
    // "a message silently becomes a number". Clearing the box IS the signal that it moved to the queue;
    // the badge count going up is the other half. Without this the user cannot tell a queue happened.
    fixture.state.sessions = [agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } })]
    fixture.state.agentComposerDrafts = { 'agent-1': 'queue me and clear the box' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as { props: { onQueue?: () => void } }
    composer.props.onQueue?.()
    expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledWith('agent-1', 'queue me and clear the box')
    expect(fixture.state.setAgentComposerDraft).toHaveBeenCalledWith('agent-1', '')
  })

  it('suppresses an accidental identical re-queue but records the first', () => {
    // 防抖 = identical-submit suppression. A double-tap that queues the same steer twice is the annoyance;
    // the second call inside the window is dropped. The first still enqueues — suppression must not eat it.
    fixture.state.sessions = [agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } })]
    fixture.state.agentComposerDrafts = { 'agent-1': 'stop double-queueing me' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as { props: { onQueue?: () => void } }
    composer.props.onQueue?.()
    composer.props.onQueue?.()
    expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledOnce()
  })

  it('offers history recall wired to the shared composer', async () => {
    // The recall callback is the shell up/down affordance. It only fires at a line boundary (checked in the
    // pure lib) and returns the value to place or null to fall through. Here: after one recorded submit,
    // arrowing up from an empty first-line draft recalls it; arrowing back down restores the (empty) draft.
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'first prompt' }
    // Record one submit through the real path so history has an entry (recorded after send() resolves).
    const first = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as { props: { onSubmit?: () => void } }
    first.props.onSubmit?.()
    fixture.state.agentComposerDrafts = { 'agent-1': '' }
    const recall = () => (AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onHistoryRecall?: (d: 'older' | 'newer', draft: string, caret: number) => string | null }
    }).props.onHistoryRecall
    // Poll until the async record lands: arrowing up from an empty first-line draft recalls the entry.
    await vi.waitFor(() => expect(recall()?.('older', '', 0)).toBe('first prompt'))
    // Back down to the live position restores the stashed (empty) draft, not the recalled entry.
    expect(recall()?.('newer', 'first prompt', 'first prompt'.length)).toBe('')
    // A bare ArrowUp with the caret NOT on the first line falls through (null) so the caret can move.
    expect(recall()?.('older', 'line one\nline two', 'line one\nline two'.length)).toBeNull()
  })

  it('lets the user retry immediately after a failed send — the guard must not swallow it', async () => {
    // 承重的那条安全性质，也是这次 P0 的直接教训：防重提交**绝不能**把一次真实失败后的重试当成
    // 误触吞掉。`AGENT_PROMPT_READINESS_CONSUMED` 那场事故里，发送会失败、用户必然重按——若失败
    // 也被记进 lastSubmit，重试就会被静默丢弃，用户看到的是「按了没反应」，而真正的病因被防御盖住。
    //
    // 判据是**调用序**：只有 send() 兑现后才记录。把 recordSubmit 挪到 try 之前（一个很自然的
    // 「先记录再发」重构）这条立刻红——同样文本、同一个窗口内的第二次提交会被判成重复而不再发出。
    // 纯 lib 的用例证不到这一点：它测的是判别函数本身，而缺陷在于**外壳何时调用它**。
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'retry me' }
    fixture.state.send.mockRejectedValueOnce(new Error('The prompt was not sent.'))

    const submit = () => (AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit?: () => void }
    }).props.onSubmit
    submit()?.()
    await vi.waitFor(() => expect(fixture.state.send).toHaveBeenCalledTimes(1))

    // 同一段文字、紧接着重试（远在防重窗口之内）：必须真的再发一次。
    submit()?.()
    await vi.waitFor(() => expect(fixture.state.send).toHaveBeenCalledTimes(2))
    expect(fixture.state.send.mock.calls[1]?.[1]).toBe('retry me')
  })

  it('keeps Stop as the working primary action even though steer submits', () => {
    // Steer must not move or replace the Stop button — a user mid-turn must not mis-click. Both an Enter
    // submit path AND a Stop interrupt path exist at once; they are different questions.
    fixture.state.sessions = [agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } })]
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit?: () => void; onInterrupt?: () => void; primaryAction: 'send' | 'stop' }
    }

    expect(composer.props.primaryAction).toBe('stop')
    expect(composer.props.onInterrupt).toBeTypeOf('function')
  })

  it('honours a codex mid-turn refusal: draft stays and no user turn is claimed', async () => {
    // codex is the one render-then-submit Provider; a mid-turn steer is fail-closed by Core
    // (AGENT_PROMPT_NOT_READY / _READINESS_CONFLICT). That is a FIRST-CLASS expected outcome, not a bug:
    // send() rejects, so the draft must survive (the honest "not sent" signal) and compare-clear must not
    // run. We deliberately do NOT assert "working always delivers" — that is false for codex and would
    // pressure someone to weaken its sealed readiness gate.
    fixture.state.sessions = [agentSession({ status: { state: 'working', source: 'native-hook', observedAt: 1 } })]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Steer while codex is mid-turn' }
    fixture.state.send.mockRejectedValueOnce(new Error('AGENT_PROMPT_NOT_READY'))
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit?: () => void }
    }

    composer.props.onSubmit?.()

    await vi.waitFor(() => expect(fixture.state.send).toHaveBeenCalledOnce())
    // Draft preserved for retry; nothing cleared — the user's words are still in the box.
    expect(fixture.state.clearAgentComposerDraftIfUnchanged).not.toHaveBeenCalled()
    expect(fixture.state.setAgentComposerDraft).not.toHaveBeenCalled()
  })

  it('queues a steer while an interaction is pending without pretending it was sent', () => {
    // The typed response card owns the interaction. Direct submit stays gated, while the explicit queue
    // action preserves the draft for delivery after the interaction is answered.
    const waiting = agentSession({
      status: { state: 'working', source: 'native-hook', observedAt: 2 },
      pendingInteraction: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow command?',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
        evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'run-1' }, hookReceiptId: 'permission-1' }
      }
    })
    fixture.state.sessions = [waiting]
    fixture.state.agentComposerDrafts = { 'agent-1': 'This must not go out' }
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onSubmit?: () => void; onQueue?: () => void; disabled: boolean }
    }

    expect(composer.props.disabled).toBe(false)
    expect(composer.props.onSubmit).toBeUndefined()
    expect(composer.props.onQueue).toBeTypeOf('function')
    composer.props.onQueue?.()
    expect(fixture.state.enqueueAgentSteer).toHaveBeenCalledWith('agent-1', 'This must not go out')
  })

  it('does not guess that a disconnected running process can accept input', () => {
    const disconnected = agentSession({
      status: { state: 'disconnected', source: 'run-process', observedAt: 2 }
    })
    fixture.state.sessions = [disconnected]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(agentComposerAvailability(disconnected)).toEqual({
      disabled: true,
      placeholder: 'Agent is disconnected'
    })
    expect(markup).toContain('placeholder="Agent is disconnected"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('stays visible and disabled before the Agent snapshot exists', () => {
    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Agent is connecting…"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('stays visible and disabled after the Agent Run exits', () => {
    const exited = agentSession({
      processState: 'exited',
      status: { state: 'exited', source: 'run-process', observedAt: 3 }
    })
    fixture.state.sessions = [exited]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(agentComposerAvailability(exited)).toEqual({
      disabled: true,
      placeholder: 'Agent is not running'
    })
    expect(markup).toContain('placeholder="Agent is not running"')
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
  })

  it('renders a Provider-declared posture control on the composer, drawn from its catalog declaration', () => {
    fixture.state.sessions = [agentSession({ providerId: 'grok', status: { state: 'running', source: 'run-process', observedAt: 2 } })]
    fixture.state.providerCatalog = [postureCatalogEntry()]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    // The control's label (the DESCRIBE half) reaches the composer; the keystroke never does.
    expect(markup).toContain('Approvals')
    expect(markup).not.toContain('always-approve')
  })

  it('renders no posture control for a Provider that declares none (absence hides)', () => {
    // codex declares no addressable posture control — its catalog entry carries no postureControl, so the
    // composer draws nothing rather than a disabled affordance.
    fixture.state.sessions = [agentSession({ status: { state: 'running', source: 'run-process', observedAt: 2 } })]
    // `postureControl` is optional and `exactOptionalPropertyTypes` is on, so `postureControl: undefined`
    // is a type error while ABSENCE is what this case is actually about. The base fixture declares one
    // (postureCatalogEntry, :127), so the key must be deleted — omitting it from the spread would keep
    // the inherited control and quietly make this test assert nothing.
    const codexEntry: AgentCatalogEntry = { ...postureCatalogEntry(), id: 'codex' }
    delete codexEntry.postureControl
    fixture.state.providerCatalog = [codexEntry]

    const markup = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))

    expect(markup).not.toContain('Approvals')
  })

  it('yields prompt entry to a pending typed Agent interaction', () => {
    const waiting = agentSession({
      status: { state: 'waiting', source: 'native-hook', observedAt: 2 },
      pendingInteraction: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow command?',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
        evidence: {
          source: 'native-hook',
          observedAt: 2,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-1'
        }
      }
    })
    fixture.state.sessions = [waiting]

    expect(agentComposerAvailability(waiting)).toEqual({
      disabled: true,
      placeholder: 'Answer the Agent request above…'
    })
  })

  // Every native action on this Composer is fired as `void action()` from a JSX handler, so a rejection
  // it does not catch itself is unobserved: the paste appears to do nothing and no error is shown. The
  // main handler throws on reachable conditions — an empty image, one over the byte cap, or any
  // mkdir/writeFile failure — so these are real user-facing paths, not defensive padding. Each must
  // reach the same reportError surface its sibling actions already use.
  it('surfaces a failed pasted-image save instead of swallowing it', async () => {
    fixture.state.sessions = [agentSession()]
    fixture.state.agentComposerDrafts = { 'agent-1': 'Look at this' }
    nativeApi.savePastedImage.mockRejectedValueOnce(new Error('Pasted image exceeds the size limit.'))
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onPasteImage(image: { bytes: Uint8Array; extension: string }): void }
    }

    composer.props.onPasteImage({ bytes: new Uint8Array([1, 2, 3]), extension: 'png' })

    await vi.waitFor(() => expect(fixture.state.reportError).toHaveBeenCalledOnce())
    expect(message(fixture.state.reportError.mock.calls[0]?.[0]))
      .toContain('Pasted image exceeds the size limit.')
    // The draft is untouched: a failed paste must not silently rewrite what the user typed.
    expect(fixture.state.setAgentComposerDraft).not.toHaveBeenCalled()
  })

  it('surfaces a failed file attachment instead of swallowing it', async () => {
    fixture.state.sessions = [agentSession()]
    nativeApi.chooseFiles.mockRejectedValueOnce(new Error('Workspace file picker failed.'))
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onAttach(): void }
    }

    composer.props.onAttach()

    await vi.waitFor(() => expect(fixture.state.reportError).toHaveBeenCalledOnce())
    expect(message(fixture.state.reportError.mock.calls[0]?.[0])).toContain('Workspace file picker failed.')
    expect(fixture.state.setAgentComposerDraft).not.toHaveBeenCalled()
  })

  it('keeps a successful paste on its existing path-reference behaviour', async () => {
    fixture.state.sessions = [agentSession()]
    const composer = AgentSessionComposer({ sessionId: 'agent-1' }) as unknown as {
      props: { onPasteImage(image: { bytes: Uint8Array; extension: string }): void }
    }

    composer.props.onPasteImage({ bytes: new Uint8Array([1]), extension: 'png' })

    // Proves the catch did not swallow the success path too: the reference still lands, silently.
    await vi.waitFor(() => expect(fixture.state.setAgentComposerDraft).toHaveBeenCalledOnce())
    expect(fixture.state.reportError).not.toHaveBeenCalled()
  })
})

it('shows the context observation owned by this session in the Composer toolbar', () => {
  fixture.state.sessions = [agentSession({ turnUsage: { inputTokens: 240, outputTokens: 10, totalTokens: 250, observedAt: 1000, context: { usedTokens: 250, capacityTokens: 1000 } } })]
  const html = renderToStaticMarkup(createElement(AgentSessionComposer, { sessionId: 'agent-1' }))
  expect(html).toContain('25% used')
  expect(html).toContain('75% remaining')
})
