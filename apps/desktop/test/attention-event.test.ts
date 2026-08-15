import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import {
  attentionEventFor,
  attentionEvents,
  categoryFor,
  nextAttentionStates,
  statusDotTier
} from '../src/renderer/src/lib/attention-event.js'
import { sessionBoardColumn } from '../src/renderer/src/lib/project-board.js'
import {
  AGENT_DISPLAY_STATES,
  isNeedsYouState
} from '../src/renderer/src/lib/attention-vocabulary.js'

function agent(
  id: string,
  state: AgentDisplayState,
  observedAt = 1
): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
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
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

// The user is elsewhere: window not focused, so nothing is being watched.
const away = { windowFocused: false, sessionVisible: false }

describe('attention event decision', () => {
  it('raises a done event when an Agent finishes while the user is away', () => {
    const event = attentionEventFor({
      session: agent('a', 'done', 42),
      previousState: 'working',
      visibility: away
    })

    expect(event).toEqual({ category: 'done', sessionId: 'a', label: 'Agent a', observedAt: 42 })
  })

  it('treats waiting and blocked as one needs-you category, matching the shared vocabulary', () => {
    // The rest of the app already collapses these two into "an Agent needs you"; a notification that
    // split them would contradict the dot sitting next to it.
    for (const state of ['waiting', 'blocked'] as const) {
      expect(
        attentionEventFor({ session: agent('a', state), previousState: 'working', visibility: away })
          ?.category
      ).toBe('needs-you')
    }
  })

  it('stays quiet when the same state is reported again', () => {
    // Providers re-announce status and a hook can deliver the same fact twice. Without this the user
    // is interrupted repeatedly for one event.
    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'done', visibility: away })
    ).toBeNull()
  })

  it('stays quiet on first sight, so attaching does not fire a burst for old work', () => {
    // Opening the app onto Sessions that finished hours ago must not notify: that is startup noise,
    // and it teaches people to ignore the channel.
    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: null, visibility: away })
    ).toBeNull()
  })

  it('does not interrupt the user with what they are already looking at', () => {
    const watching = { windowFocused: true, sessionVisible: true }

    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'working', visibility: watching })
    ).toBeNull()
  })

  it('still notifies for a focused window when that Session is off screen', () => {
    // A collapsed pane or a background tab group is not visible even with the window focused, so the
    // completion would otherwise go unseen.
    const elsewhere = { windowFocused: true, sessionVisible: false }

    expect(
      attentionEventFor({ session: agent('a', 'done'), previousState: 'working', visibility: elsewhere })
        ?.category
    ).toBe('done')
  })

  it('still notifies when the window lost focus, even though the Session is on screen', () => {
    // 这是最常见的那一种：你在等这个 Agent，切去浏览器看点别的，它跑完了。Session 还摊在屏幕上
    // （tab 没换），但你的眼睛不在那儿——正是该出通知的时刻。
    //
    // 判据落在 `&&` 的**接受**侧。压制条件是 `windowFocused && sessionVisible`，而此前三个 fixture
    // 是 {F,F}、{T,T}、{T,F}：把 `windowFocused &&` 整段删掉，三者的结果一个都不变
    //（实测：删掉那半个合取项，八个文件 94 条全绿）。少的就是这第四种组合 {F,T}，而它恰好是
    // 「切到别的应用」——删掉之后，这条路上的完成通知永久静默。
    const screenOnButLookingElsewhere = { windowFocused: false, sessionVisible: true }

    expect(
      attentionEventFor({
        session: agent('a', 'done'),
        previousState: 'working',
        visibility: screenOnButLookingElsewhere
      })?.category
    ).toBe('done')

    // 四种组合各钉一次，把「只有两者同时成立才压制」写成穷举而不是三个例子。少一格就是少一条路。
    const suppressed = ([true, false] as const).flatMap((windowFocused) =>
      ([true, false] as const).map((sessionVisible) => ({
        windowFocused,
        sessionVisible,
        quiet:
          attentionEventFor({
            session: agent('a', 'done'),
            previousState: 'working',
            visibility: { windowFocused, sessionVisible }
          }) === null
      }))
    )
    expect(suppressed).toEqual([
      { windowFocused: true, sessionVisible: true, quiet: true },
      { windowFocused: true, sessionVisible: false, quiet: false },
      { windowFocused: false, sessionVisible: true, quiet: false },
      { windowFocused: false, sessionVisible: false, quiet: false }
    ])
  })

  it('never raises attention for lifecycle noise or a dropped link', () => {
    // disconnected is absent on purpose: it is not a request for attention, and it has its own neutral
    // treatment precisely so amber means needs-you and nothing else. starting/running/exited are
    // process facts the tab and Board already carry.
    for (const state of ['starting', 'running', 'disconnected', 'exited', 'unknown'] as const) {
      expect(categoryFor(state as AgentDisplayState)).toBeNull()
      expect(
        attentionEventFor({
          session: agent('a', state as AgentDisplayState),
          previousState: 'working',
          visibility: away
        })
      ).toBeNull()
    }
  })

  it('raises an error event so a failure is not quieter than a success', () => {
    expect(
      attentionEventFor({ session: agent('a', 'error'), previousState: 'working', visibility: away })
        ?.category
    ).toBe('error')
  })

  it('folds a batch and ignores non-agent sessions', () => {
    const terminal = {
      id: 't',
      kind: 'terminal' as const,
      hostId: 'local',
      workspacePath: '/repo',
      label: 'Terminal',
      createdAt: 1,
      updatedAt: 1,
      processState: 'running' as const,
      status: { state: 'running' as const, source: 'run-process' as const, observedAt: 1 },
      latestOutputBytes: 0,
      control: { kind: 'terminal' as const, hostId: 'local', run: { runId: 'run-t' } }
    } as unknown as SessionSnapshot

    const events = attentionEvents({
      sessions: [agent('a', 'done', 5), agent('b', 'waiting', 3), agent('c', 'working'), terminal],
      previousStates: new Map<string, AgentDisplayState>([
        ['a', 'working'],
        ['b', 'working'],
        ['c', 'starting']
      ]),
      visibilityFor: () => away
    })

    expect(events.map((event) => [event.sessionId, event.category])).toEqual([
      ['a', 'done'],
      ['b', 'needs-you']
    ])
  })

  it('forgets Sessions that disappeared so a returning one is a first sight again', () => {
    // Remembering a vanished Session would make its return look like a transition nobody witnessed.
    const states = nextAttentionStates([agent('a', 'done'), agent('b', 'working')])
    expect([...states.entries()]).toEqual([['a', 'done'], ['b', 'working']])

    const afterClose = nextAttentionStates([agent('b', 'working')])
    expect(afterClose.has('a')).toBe(false)
  })
})

describe('statusDotTier：一行的状态点画哪一档', () => {
  // 由来是一个**当时就看得见**的分岔：名册行与 fan-out lane 各写了一遍四行判定，两份都以
  // `state === 'working' ? 'working' : null` 收尾。于是 `running`（活着、两个 turn 之间）与「压根没有
  // 状态」得到同一个答案，点画成静止的中性灰；而状态栏计数和项目→Agent 树都按 sessionBoardColumn
  // 分桶（starting/running/working 都算 working）。标题说 working，点是灰的。

  it('running 有自己的一档，不塌成「什么都没有」——这就是那个分岔', () => {
    expect(statusDotTier('running')).toBe('running')
    // 而 working 仍是 working：两档必须彼此可区分，否则「合并成一档」这种改动悄悄溜过。
    expect(statusDotTier('working')).toBe('working')
    expect(statusDotTier('running')).not.toBe(statusDotTier('working'))
  })

  it('凡是被计数算成 working 的状态，点都不是「没有档位」——除了瞬态的 starting', () => {
    // 这条是这组的重点：它不逐个点名状态，而是**拿计数的那张表当判据**。谁算在 working 列，谁就
    // 不该画成静止灰——标题说有 N 个在干活，点却是灰的，是同一个事实的两种说法。
    // starting 是唯一的例外，且是显式的：它只闪几百毫秒，为它亮一档是噪音不是信息。
    const workingColumn = (['starting', 'running', 'working'] as const).filter(
      (state) => sessionBoardColumn({ status: { state } } as never) === 'working'
    )
    // 自证：上面这个 filter 必须真的筛出东西，否则下面的循环是死代码。
    expect(workingColumn).toEqual(['starting', 'running', 'working'])

    for (const state of workingColumn) {
      const tier = statusDotTier(state)
      if (state === 'starting') {
        expect(tier, 'starting 是瞬态，刻意不给档位').toBeNull()
        continue
      }
      expect(tier, `${state} 被计数算作 working，点却没有档位——这正是修掉的那个分岔`).not.toBeNull()
    }
  })

  it('要人处理的两个状态各画各的档，判定取自共享的那张表', () => {
    // 判据不点名状态，而是遍历 needs-you 表本身：表里加了成员却在这里落到 null，这条当场红。
    for (const state of AGENT_DISPLAY_STATES.filter(isNeedsYouState)) {
      expect(statusDotTier(state), `${state} 要人处理，却没有档位`).toBe(state)
    }
    // 自证：表必须真的筛出东西。
    expect(AGENT_DISPLAY_STATES.filter(isNeedsYouState).length).toBeGreaterThan(0)
    expect(statusDotTier('error')).toBe('error')
  })

  it('没有状态（比如还没有 Session 的 lane）就是静止的那一档', () => {
    expect(statusDotTier(null)).toBeNull()
    expect(statusDotTier('done')).toBeNull()
  })

  it('每一档都在样式表里有规则——没有规则的档位等于画了个寂静', () => {
    // 判定层返回一个 CSS 不认识的档位，等于这行什么都没画，而上面几条断言照样全绿。所以直接读样式表。
    // 档位清单不手抄：把整个状态联合过一遍判定层，拿到的就是它今天会发出的全部档位。新增一个状态
    // 并给它一档、却忘了写 CSS 规则，这条当场红。
    const css = readFileSync(new URL('../src/renderer/src/styles/chrome.css', import.meta.url), 'utf8')
    const tiers = [...new Set(AGENT_DISPLAY_STATES.map(statusDotTier))].filter(
      (tier): tier is Exclude<typeof tier, null> => tier !== null
    )
    expect(tiers.sort(), '自证：判定层必须真的发得出这几档').toEqual([
      'blocked',
      'error',
      'running',
      'waiting',
      'working'
    ])
    for (const tier of tiers) expect(css, `chrome.css 没有 .status--${tier}`).toContain(`.status--${tier}`)

    // running 是绿的、但**不脉冲**：脉冲的含义是「此刻有一个 turn 在途」，一个等你说话的 Agent
    // 活着但不在途中。把这条钉住，免得有人顺手把它并进 working 的动画规则。
    const pulseRule = css.slice(css.indexOf('animation: pulse'), css.indexOf('animation: pulse') + 4)
    expect(pulseRule, '自证：样式表里得真有 pulse 动画，否则下一条恒真').toBe('anim')
    const pulseLine = css.split('\n').find((line) => line.includes('animation: pulse') && line.includes('status'))
    expect(pulseLine, '找不到状态点的 pulse 规则行').toBeDefined()
    expect(pulseLine, 'running 不该脉冲——脉冲留给「此刻有 turn 在途」').not.toContain('status--running')
  })
})
