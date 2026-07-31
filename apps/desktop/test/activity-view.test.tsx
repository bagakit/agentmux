import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ActivityView } from '../src/renderer/src/components/ActivityView.js'

function activity(
  id: string,
  overrides: Partial<AgentTimelineItem> = {}
): AgentTimelineItem {
  return {
    id,
    agentSessionId: 'agent-1',
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Assistant response',
    ...overrides
  }
}

function render(
  capability: 'unavailable' | 'complete-events' | 'streaming',
  items: AgentTimelineItem[] = []
): string {
  return renderToStaticMarkup(createElement(ActivityView, { capability, items }))
}

describe('ActivityView', () => {
  it('states that structured Activity is unavailable without inventing Terminal-derived items', () => {
    const markup = render('unavailable', [activity('stale-item')])

    expect(markup).toContain('does not provide structured activity')
    expect(markup).toContain('Terminal remains available')
    expect(markup).not.toContain('Assistant response')
  })

  it('distinguishes an available but empty Timeline from an unavailable capability', () => {
    const markup = render('complete-events')

    expect(markup).toContain('No structured activity yet')
    expect(markup).not.toContain('does not provide structured activity')
  })

  it('renders Core Timeline status, provenance, and prose without Provider branches', () => {
    const markup = render('streaming', [
      activity('ask', {
        kind: 'user_message',
        source: 'user',
        title: 'Prompt',
        content: 'Ship it',
        createdAt: 1,
        updatedAt: 1
      }),
      activity('edit', {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Edit',
        toolName: 'Edit',
        toolInput: 'runtime.ts',
        createdAt: 2,
        updatedAt: 2
      }),
      activity('failed', {
        kind: 'tool_call',
        status: 'failed',
        source: 'acp',
        title: 'Run tests',
        toolName: 'shell',
        toolInput: 'pnpm test',
        createdAt: 3,
        updatedAt: 3
      }),
      activity('reply', {
        status: 'streaming',
        source: 'native-hook',
        content: 'Working on it',
        createdAt: 4,
        updatedAt: 4
      })
    ])

    expect(markup).toContain('Structured Session activity only')
    expect(markup).toContain('never Terminal output or private chain-of-thought')
    expect(markup).toContain('Streaming')
    expect(markup).toContain('Failed')
    // Provenance lives on the machine rows; a turn carries its speaker in the caption and glyph, not a
    // native-hook/user label, so the register split is what keeps the conversation from reading machine.
    expect(markup).toContain('native-hook')
    expect(markup).toContain('acp')
    // Prose the agent and user produced is the substance of the trace and always renders.
    expect(markup).toContain('Working on it')
    expect(markup).toContain('Ship it')
    // A tool's arguments are machine payload: the row names the call and keeps the argv folded until
    // asked for, which is what stops a repeated tool loop from burying the conversation.
    expect(markup).toContain('Run tests')
    expect(markup).not.toContain('pnpm test')
  })

  it('folds a run of machine-reported steps into one disclosure and counts identical repeats', () => {
    const hook = (id: string, createdAt: number) =>
      activity(id, {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Bash',
        toolName: 'bash',
        toolInput: 'ls -la',
        createdAt,
        updatedAt: createdAt
      })
    const markup = render('complete-events', [
      activity('ask', { kind: 'user_message', source: 'user', title: 'User prompt', content: 'User prompt', createdAt: 1 }),
      hook('h1', 2),
      hook('h2', 3),
      hook('h3', 4),
      activity('reply', { source: 'acp', title: 'Assistant response', content: 'Assistant response', createdAt: 5, updatedAt: 5 })
    ])

    // The run collapses to a single summary row; the turns around it stay visible — their words render
    // in the turn register, not (as they once incidentally did) in a ruler tick's tooltip.
    expect(markup).toContain('3 steps')
    expect(markup).toContain('User prompt')
    expect(markup).toContain('Assistant response')
    // Collapsed means collapsed: the repeated step rows are not in the log at all. (The ruler still
    // carries a tick per event, so scope the check to the log itself.)
    const log = markup.slice(markup.indexOf('activity-log'))
    expect(log).not.toContain('Bash')
  })

  it('renders a user turn in the turn register — a speaker caption over the words, not a machine row', () => {
    const markup = render('complete-events', [
      activity('ask', {
        kind: 'user_message',
        source: 'user',
        title: 'Prompt',
        content: 'Make the adapter observable.'
      })
    ])

    // The turn lands in the conversation register, not the machine Row.
    expect(markup).toContain('log-turn log-turn--user_message')
    expect(markup).not.toContain('log-row log-row--user_message')
    // The words are the substance; the caption is the human speaker, not the generic machine title.
    expect(markup).toContain('log-turn__body')
    expect(markup).toContain('Make the adapter observable.')
    expect(markup).toContain('You')
  })

  it('never folds the assistant reply into a machine run, even when it is native-hook next to a tool call', () => {
    // Mirrors the shipped trace: a native-hook tool_call immediately followed by the native-hook
    // assistant reply. Folding by source alone would sweep the reply into "2 steps" and hide it.
    const markup = render('complete-events', [
      activity('a2', {
        kind: 'tool_call',
        source: 'native-hook',
        title: 'Edit',
        toolName: 'Edit',
        toolInput: 'packages/core/src/runtime.ts',
        createdAt: 1,
        updatedAt: 1
      }),
      activity('a3', {
        kind: 'assistant_message',
        source: 'native-hook',
        title: 'Assistant response',
        content: 'The runtime now emits typed session events from one owner.',
        createdAt: 2,
        updatedAt: 2
      })
    ])

    // The reply is a turn, on screen, in full — never behind a default-closed disclosure.
    expect(markup).toContain('log-turn log-turn--assistant_message')
    expect(markup).toContain('The runtime now emits typed session events from one owner.')
    expect(markup).toContain('Assistant')
    // The lone tool_call renders as a machine row; its argv stays folded.
    expect(markup).toContain('Edit')
    expect(markup).not.toContain('packages/core/src/runtime.ts')
  })

  it('renders a mid-turn steer as an interjection in the turn register, between the machine steps', () => {
    // A steer submitted while the Agent is working is recorded by Core as a `source: 'user'`
    // `user_message` landing BETWEEN the run's native-hook steps. It must read as conversation — a full
    // turn, never folded into the "N steps" run around it — so the trace shows when the human interjected
    // and why the Agent changed course. It keeps source 'user'; it never masquerades as native-hook.
    const markup = render('complete-events', [
      activity('h1', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
        createdAt: 1, updatedAt: 1
      }),
      activity('h2', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
        createdAt: 2, updatedAt: 2
      }),
      activity('steer', {
        kind: 'user_message', source: 'user', title: 'Prompt',
        content: 'Actually, focus on the parser instead.', createdAt: 3, updatedAt: 3
      }),
      activity('h3', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'parser.ts',
        createdAt: 4, updatedAt: 4
      }),
      activity('h4', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'parser2.ts',
        createdAt: 5, updatedAt: 5
      })
    ])

    // The steer renders as a turn with its words on screen — not a machine row, never behind a fold.
    expect(markup).toContain('log-turn log-turn--user_message')
    expect(markup).toContain('Actually, focus on the parser instead.')
    expect(markup).toContain('You')
    expect(markup).not.toContain('log-row log-row--user_message')

    // It is bracketed by machine steps, proving it landed mid-turn: the two runs on either side each fold
    // to "2 steps", and the steer sits between them rather than being swept into either.
    const log = markup.slice(markup.indexOf('activity-log'))
    expect(log).toContain('2 steps')
    const turnAt = log.indexOf('log-turn--user_message')
    const firstFold = log.indexOf('2 steps')
    const lastFold = log.lastIndexOf('2 steps')
    expect(firstFold).toBeGreaterThanOrEqual(0)
    expect(lastFold).toBeGreaterThan(firstFold) // two distinct folds exist
    expect(turnAt).toBeGreaterThan(firstFold) // steer comes after the first run
    expect(turnAt).toBeLessThan(lastFold) // and before the second — i.e. between the machine steps
  })

  it('shows no turn for a refused steer — a rejected submit records nothing', () => {
    // Core throws its readiness/interaction refusal BEFORE recordPromptAfterSideEffect, so a refused steer
    // appends no timeline item at all. The trace for a run whose steer was rejected therefore carries only
    // the machine steps — no user turn and no failed placeholder. Without this assertion a future real
    // dropped event would look identical to normal and pass silently.
    const markup = render('complete-events', [
      activity('h1', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
        createdAt: 1, updatedAt: 1
      }),
      activity('h2', {
        kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
        createdAt: 2, updatedAt: 2
      })
    ])

    expect(markup).not.toContain('log-turn--user_message')
    expect(markup).not.toContain('log-turn__body')
    // The machine steps that did happen are still there — the trace is not empty, it simply has no turn.
    expect(markup).toContain('2 steps')
  })

  it('spaces the ruler by real elapsed time, and says so when there is none to show', () => {
    const spread = render('complete-events', [
      activity('a', { createdAt: 1_000, updatedAt: 1_000 }),
      activity('b', { createdAt: 3_000, updatedAt: 3_000 }),
      activity('c', { createdAt: 5_000, updatedAt: 5_000 })
    ])
    // The middle event sits at the middle of the track: the axis is honest about the gaps.
    expect(spread).toContain('data-axis="temporal"')
    expect(spread).toContain('left:50%')

    // Same-instant events carry no spread to map, so they fall back to even ordinal spacing rather
    // than stacking every tick on the left edge and reading as a single event.
    const flat = render('complete-events', [
      activity('a', { createdAt: 1, updatedAt: 1 }),
      activity('b', { createdAt: 1, updatedAt: 1 }),
      activity('c', { createdAt: 1, updatedAt: 1 })
    ])
    expect(flat).toContain('data-axis="ordinal"')
    expect(flat).toContain('left:50%')
  })

  it('exposes the ruler as one focusable slider whose accessible value is honest per axis', () => {
    // The ruler is a single interactive control: focusable (tabindex, role=slider), and its accessible
    // name/value describe the axis without over-claiming. A temporal axis may name elapsed time; an
    // ordinal axis says only that the spacing is order. This is the a11y contract for click+keyboard.
    const temporal = render('complete-events', [
      activity('a', { createdAt: 1_000, updatedAt: 1_000 }),
      activity('b', { createdAt: 3_000, updatedAt: 3_000 })
    ])
    expect(temporal).toContain('role="slider"')
    expect(temporal).toContain('tabindex="0"')
    expect(temporal).toContain('aria-valuemin="1"')
    expect(temporal).toContain('aria-valuemax="2"')
    // The temporal axis is allowed to name the elapsed span in its label.
    expect(temporal).toMatch(/aria-label="Activity timeline, 2 events over [^"]*s"/)

    const ordinal = render('complete-events', [
      activity('a', { createdAt: 5, updatedAt: 5 }),
      activity('b', { createdAt: 5, updatedAt: 5 }),
      activity('c', { createdAt: 5, updatedAt: 5 })
    ])
    // The ordinal axis must NOT smuggle a duration into its label — order only, no fabricated span.
    expect(ordinal).toContain('aria-label="Activity timeline, 3 events in order"')
    expect(ordinal).not.toMatch(/aria-(label|valuetext)="[^"]*over[^"]*"/)
    // And nothing in the ordinal ruler renders a wall-clock time — no ":" time string leaks into a
    // tick title the way the pre-interactive ruler used to unconditionally emit one.
    const ruler = ordinal.slice(ordinal.indexOf('activity-ruler'), ordinal.indexOf('activity-log'))
    expect(ruler).not.toMatch(/title="[^"]*\d{1,2}:\d{2}/)
  })

  it('wraps each log segment in a scroll target the ruler can jump to, without a second scroller', () => {
    // Click/keyboard resolve a position to an event and scroll its host segment into view. The wiring is
    // the per-segment wrapper carrying a data key; the scroll itself reuses the shared scrollIntoView
    // primitive at runtime. Asserting the wrapper exists proves the target the jump lands on is real.
    const markup = render('complete-events', [
      activity('ask', { kind: 'user_message', source: 'user', title: 'Prompt', content: 'Hi', createdAt: 1 }),
      activity('reply', { source: 'native-hook', content: 'There', createdAt: 2_000, updatedAt: 2_000 })
    ])
    expect(markup).toContain('activity-log__segment')
  })

  /**
   * 结果接线。判定层（`activity-timeline-rows`、Core 的 `hook-tool-outcome`）再对，View 不把
   * 结果交出去，对话里失败与成功仍然长得一模一样，而那两处的用例照样全绿。
   */
  it('失败的一步在对话里就与成功的不一样，不必展开也看得出', () => {
    const markup = render('complete-events', [
      activity('ok', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash',
        toolInput: '{"command":"echo hi"}', toolOutput: 'hi', createdAt: 1
      }),
      activity('bad', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash', status: 'failed',
        toolInput: '{"command":"exit 1"}', toolOutput: 'command failed', createdAt: 2
      })
    ])

    // 折叠状态下的可见区分：状态属性 + Failed 徽标。两者都不依赖展开。
    expect(markup).toContain('data-status="failed"')
    expect(markup).toContain('log-row__chip--failed')
    // 成功那一行不许也被标成失败——「两者显示相同即等于没做」。
    expect(markup).toContain('data-status="complete"')
  })

  it('只有结果没有入参的一步仍然可展开——否则唯一有用的信息被挡在外面', () => {
    // `expandable` 曾经只看 payload。一条没有入参却有输出（或失败）的步骤会退化成不可点的死行。
    const markup = render('complete-events', [
      activity('out-only', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash', toolOutput: 'boom', createdAt: 1
      })
    ])

    expect(markup).toContain('data-expandable')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('同一步的入参行与结果行在对话里只占一行，且留下的是带结果的那条', () => {
    // View 把折叠换成 `timelineRows` 这件事本身要被守住：换回旧的按顺序折叠，这条会红。
    // 多步会被 Run 折叠体包起来（展开前只显示 "N steps / M unique"），所以这里断言的是折叠体
    // 给出的计数——两条折成一条 unique，且整个 Run 被标为失败。
    const markup = render('complete-events', [
      activity('pre', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash',
        toolInput: '{"command":"exit 1"}', createdAt: 1
      }),
      activity('post', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash', status: 'failed',
        toolInput: '{"command":"exit 1"}', createdAt: 2, updatedAt: 2
      })
    ])

    expect(markup).toContain('2 steps')
    expect(markup).toContain('1 unique')
    expect(markup).toContain('log-row__chip--failed')
  })

  it('没有结果的历史条目照常渲染，不因为新字段缺席就报错或显示空壳', () => {
    const markup = render('complete-events', [
      activity('legacy', {
        kind: 'tool_call', title: 'Read', toolName: 'Read',
        toolInput: '{"file_path":"/a.ts"}', createdAt: 1
      })
    ])

    expect(markup).toContain('Read')
    expect(markup).not.toContain('log-row__output')
    expect(markup).not.toContain('log-row__chip--failed')
  })

  it('说话人由 source 认定，渲染层不按 kind 反推身份', () => {
    // 这条守的是判据来源，不是显示结果。`kind:'user_message'` 与 `source:'user'` 在今天恒等价
    // （Core 里只有 launch/send 一处产生用户消息，同时写死两个字段），所以上面每一条既有断言在
    // 「按 source 认」和「按 kind 认」两种实现下都会绿——把身份判定收敛进 conversation-speaker
    // 这件事本身没有任何渲染断言守着。
    //
    // 所以这里构造一条只有 source 说话的条目：source 是 'user'，kind 不是 user_message。按 kind
    // 反推的实现会把人说的话画成 Assistant 的话（设计 SSOT 明令禁止渲染层按 kind 反推身份），
    // 这条会红；按 source 认的实现给出 'You'。
    const markup = render('complete-events', [
      activity('steer-only-source', {
        source: 'user',
        kind: 'lifecycle',
        title: 'Prompt',
        content: '换个方向'
      })
    ])

    expect(markup).toContain('You')
    expect(markup).not.toContain('>Assistant<')
    // 而且它必须走 turn register，不能被当成机器行——「是一轮对话」与「谁说的」是同一个判据。
    expect(markup).toContain('log-turn')
    expect(markup).not.toContain('log-row log-row--lifecycle')
  })
})
