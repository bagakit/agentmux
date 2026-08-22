import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ActivityView } from '../src/renderer/src/components/ActivityView.js'
import { allStyles } from './helpers/styles.js'

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

/**
 * 只取那一行本身的标记。
 *
 * 为什么必须切出来：`data-status` 不止画在行上，ruler 的刻度（ActivityView.tsx:322）也带同一个属性，
 * 而刻度是另一条独立守住的东西。于是对整份文档 `toContain('data-status="failed"')` **由刻度满足**，
 * 根本没有质询到行——把行上的 `data-status` 改成常量 `"complete"`，那样的断言实测仍然全绿。判据必须
 * 落在行的那一段里。
 *
 * 行里不嵌另一行，故行起点之后第一个 `</div>`／`</button>` 就是它自己的收尾（子元素只有 span 与 svg）。
 */
function logRowMarkup(markup: string): string {
  const marker = markup.indexOf('class="log-row ')
  expect(marker, '没渲染出行——判据落空了，下面的断言会变成恒真').toBeGreaterThanOrEqual(0)
  expect(
    markup.indexOf('class="log-row ', marker + 1),
    '渲染出了多行，切出来的是哪一行不确定——请只喂一条 item'
  ).toBe(-1)
  const start = markup.lastIndexOf('<', marker)
  const ends = [markup.indexOf('</div>', marker), markup.indexOf('</button>', marker)]
    .filter((index) => index >= 0)
  expect(ends.length, '行没有收尾标签，切法的前提不成立').toBeGreaterThan(0)
  const row = markup.slice(start, Math.min(...ends))
  // 自检：切出来的这段必须**真的**把 ruler 甩掉了，否则它与整份文档等价，上面那段解释就落空了。
  expect(row, '切出来的一段里还有 ruler——它会替行满足 data-status 断言').not.toContain('activity-ruler')
  expect(row, '切出来的一段里没有行的标记区，说明切早了').toContain('log-row__meta')
  return row
}

/**
 * 带上说话人解析后的渲染。既有的 `render` 刻意不传 `describeSpeaker`——那既是「不给就不画轴」这条
 * 退化路径的实测，也让本文件既有的每条断言与两条新轴完全解耦（轴根本没渲染）。
 */
function renderWithSpeakers(items: AgentTimelineItem[]): string {
  return renderToStaticMarkup(
    createElement(ActivityView, {
      capability: 'complete-events',
      items,
      describeSpeaker: (speaker: { role: 'human' | 'agent'; id: string }) =>
        speaker.role === 'human' ? { name: 'You' } : { name: 'Claude', providerId: 'claude' as const }
    })
  )
}

describe('ActivityView 与两条对话轴的接线', () => {
  it('Codex 对话模式逐条显示相邻的用户消息', () => {
    const markup = render('complete-events', [
      activity('u1', { kind: 'user_message', source: 'user', title: 'Prompt', content: '第一句', createdAt: 1 }),
      activity('u2', { kind: 'user_message', source: 'user', title: 'Prompt', content: '第二句', createdAt: 2 })
    ])
    expect(markup.match(/class="log-turn" data-speaker-role="human"/g)).toHaveLength(2)
    expect(markup).toContain('第一句')
    expect(markup).toContain('第二句')
  })

  it('两条轴都接上了，且各自只收自己那一类身份', () => {
    // 这条守的是**接线本身**。轴组件自己的验收在 conversation-axis-render.test.tsx，但那证明不了
    // ActivityView 真的渲染了它——一个组件写好却没人调用，两边的测试都会绿。
    const markup = renderWithSpeakers([
      activity('u1', { kind: 'user_message', source: 'user', createdAt: 0, content: '问' }),
      activity('t1', { kind: 'tool_call', source: 'native-hook', createdAt: 100 }),
      activity('a1', { kind: 'assistant_message', source: 'native-hook', createdAt: 200, content: '答' })
    ])
    // 两条轴各有自己的可访问名，两枚头像各是自己那一路的画法。
    expect(markup).toContain('aria-label="Speakers"')
    expect(markup).toContain('aria-label="This agent"')
    expect(markup).toContain('conversation-avatar--human')
    expect(markup).toContain('conversation-avatar--agent')
    // 机器上报不在任何一条轴上：两条轴合起来恰好两枚标记（u1 与 a1），tool_call 不占位。
    expect(markup.match(/conversation-axis__mark/g)).toHaveLength(2)
  })

  it('不给 describeSpeaker 就不画轴——名字缺席时头像认不出谁，画出来只是装饰', () => {
    // 本文件其余每条断言都走这条路（`render` 不传该 prop），所以这条同时是那些断言与新轴解耦的
    // 证明：轴根本没渲染，既有断言不可能被它影响。
    const markup = render('complete-events', [
      activity('u1', { kind: 'user_message', source: 'user', createdAt: 0, content: '问' })
    ])
    expect(markup).not.toContain('conversation-axis')
    expect(markup).not.toContain('aria-label="Speakers"')
    // 但主刻度照旧在：轴是加在它之上的，不是替换它。
    expect(markup).toContain('activity-ruler')
  })

  it('轴与主刻度在同一个坐标盒里，所以同一个百分比是同一个像素', () => {
    // 这条守的是 review 抓出来的真缺陷：两条轴原先是 `.activity-ruler` 的**兄弟**（全宽无 padding），
    // 而 tick 的 `left:N%` 解析在 `.activity-ruler__track` 里——那个盒被 12px 侧 padding 内推、右侧
    // 还被 `__span` 读数与 `__note` 挤掉近百像素。于是两处的同一个 fraction 落在不同像素上，越往右
    // 偏得越多，最后一枚头像会浮在它该指向的 tick 右边一个时间戳的宽度处。
    //
    // 判据必须是**结构**（两者共享同一个 position 容器），不能只是"轴出现在 track 之前"——后者在
    // 修好之后恒为真，是一条守不住任何东西的断言。
    const markup = renderWithSpeakers([
      activity('u1', { kind: 'user_message', source: 'user', createdAt: 0, content: '问' }),
      activity('a1', { kind: 'assistant_message', source: 'native-hook', createdAt: 1_000, content: '答' })
    ])
    // 共享盒存在，且轴与 track 都在它**里面**：stack 开始之后才出现轴，轴与 track 之间没有它的闭合。
    const stackAt = markup.indexOf('activity-ruler__stack')
    const axisAt = markup.indexOf('conversation-axis')
    const trackAt = markup.indexOf('activity-ruler__track')
    expect(stackAt).toBeGreaterThanOrEqual(0)
    expect(stackAt).toBeLessThan(axisAt)
    expect(axisAt).toBeLessThan(trackAt)
    // 轴不再是 ruler 的兄弟：`.activity-ruler` 与轴之间只能隔着 stack，不能隔着 ruler 的闭合标签。
    const rulerAt = markup.indexOf('class="activity-ruler"')
    expect(rulerAt).toBeGreaterThanOrEqual(0)
    expect(rulerAt).toBeLessThan(stackAt)
    // 而右侧那两件（读数、note）必须留在共享盒之外——它们正是 track 自己不能当共享盒的原因。
    expect(markup.indexOf('activity-ruler__span')).toBeGreaterThan(trackAt)
  })

  it('轴与主刻度对同一事件给出同一个百分比', () => {
    const items = [
      activity('u1', { kind: 'user_message', source: 'user', createdAt: 0, content: '问' }),
      activity('t1', { kind: 'tool_call', source: 'native-hook', createdAt: 250 }),
      activity('a1', { kind: 'assistant_message', source: 'native-hook', createdAt: 1_000, content: '答' })
    ]
    const markup = renderWithSpeakers(items)
    const axes = markup.slice(0, markup.indexOf('activity-ruler__track'))
    const ruler = markup.slice(markup.indexOf('activity-ruler__track'))
    // a1 在 1000/1000 = 100%：轴上的头像与主刻度上的 tick 都落在 100%。
    expect(axes).toContain('left:100%')
    expect(ruler).toContain('left:100%')
    // 而 tool_call 在 25%，只出现在主刻度上——轴不吞机器上报。
    expect(ruler).toContain('left:25%')
    expect(axes).not.toContain('left:25%')
  })
})

describe('对话正文的说话人形状', () => {
  /** 只取正文那一段——轴上也有头像，不切开就会把轴的头像误当成正文的。 */
  function logOf(markup: string): string {
    return markup.slice(markup.indexOf('activity-log'))
  }

  const conversation = [
    activity('u1', { kind: 'user_message', source: 'user', createdAt: 0, content: '人说的话' }),
    activity('a1', { kind: 'assistant_message', source: 'native-hook', createdAt: 100, content: 'Agent 说的话' })
  ]

  it('user 与 Agent 的话在正文里形状不同——两个身份各自一枚头像，不再共用一种形状', () => {
    // 这条是 T-006 的实质，也是用户报的那句「user 消息也会被收进 Agent 的历史, 感觉不够优雅」的
    // 直接验收：两条发言过去共用一枚按 kind 选的图标，现在各带自己身份的头像。
    const log = logOf(renderWithSpeakers(conversation))
    expect(log).toContain('data-speaker-role="human"')
    expect(log).toContain('data-speaker-role="agent"')
    // 头像真的在正文里，不只在轴上——组件写好却没在这一路被调用，其他断言都会绿。
    expect(log).toContain('conversation-avatar--human')
    expect(log).toContain('conversation-avatar--agent')
    // 正文两枚头像各一枚，且都坐在 spine 的节点槽里。
    expect(log.match(/log-turn__node/g)).toHaveLength(2)
  })

  it('caption 给的是 describe 出来的名字，不是 role 的字面量——名字才是身份的判别器', () => {
    // 色相有约 52%（4 个身份）概率撞在 20° 内、同 provider 又共用一枚品牌图标，所以两个 Agent 能不
    // 能被认出来只能压在名字上。这条钉住正文 caption 走 describe：写死 'Assistant' 会红。
    const log = logOf(renderWithSpeakers(conversation))
    expect(log).toContain('Claude')
    expect(log).not.toContain('>Assistant<')
  })

  it('没有 describeSpeaker 时仍按身份分形状，只是退回 role 的名字', () => {
    // 退化路径要仍然分得开：`describeSpeaker` 缺席时头像认不出「具体是谁」，但「人 还是 Agent」这
    // 一层由 role 决定，与 store 无关，所以形状不许一起塌掉。
    const log = logOf(render('complete-events', conversation))
    expect(log).toContain('data-speaker-role="human"')
    expect(log).toContain('data-speaker-role="agent"')
    expect(log).toContain('conversation-avatar--human')
    expect(log).toContain('conversation-avatar--agent')
    // 轴没画（那条已单独实测），所以这些头像只可能来自正文。
    expect(log).not.toContain('conversation-axis')
  })

  it('形状属性、头像、caption 三者同源——不许有一个脱离身份单独漂移', () => {
    // 实测出来的洞：把 `data-speaker-role` 单独改成按 kind 反推（头像与 caption 仍走 speaker.role），
    // 上面每一条断言都绿——因为它们各自只看三者之一，没有人看见「同一个元素上两个矛盾的答案」。
    // 那种状态下 CSS 按属性选到的是 agent 的排版，而里面画的是人的头像。
    //
    // 判据用 `source:'user'` 但 `kind:'lifecycle'` 这条：两个字段在这里故意不一致，于是「按 source
    // 认」与「按 kind 反推」给出相反的结论，三者必须一致地站在 source 那一边。
    const log = logOf(
      render('complete-events', [
        activity('steer-only-source', { source: 'user', kind: 'lifecycle', title: 'Prompt', content: '换个方向' })
      ])
    )
    expect(log).toContain('data-speaker-role="human"')
    expect(log).toContain('conversation-avatar--human')
    expect(log).toContain('log-turn__who">You')
    // 反向：agent 的三件套一个都不许出现在这条人说的话上。
    expect(log).not.toContain('data-speaker-role="agent"')
    expect(log).not.toContain('conversation-avatar--agent')
  })

  it('机器上报仍按 kind 画自己的图标——两个寄存器各有各的判据', () => {
    // 反向边界：把 `Glyph` 的 kind 分支也改成身份驱动是错的，`tool_call` 是一把锤子回答的是「这是
    // 什么事件」。这条钉住机器行不长出头像、也不带说话人属性。
    const log = logOf(
      renderWithSpeakers([
        activity('t1', { kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', createdAt: 0 })
      ])
    )
    expect(log).toContain('log-row')
    expect(log).not.toContain('data-speaker-role')
    expect(log).not.toContain('conversation-avatar')
  })
})

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

    // The turn lands in the conversation register, not the machine Row. The register is selected by
    // SPEAKER, not by kind — `data-speaker-role` is what the identity verdict puts on the element.
    expect(markup).toContain('class="log-turn" data-speaker-role="human"')
    expect(markup).not.toContain('log-row log-row--user_message')
    // kind 不再驱动对话体的形状：留下这条，是因为回到 `log-turn--user_message` 就等于把「谁说的」
    // 重新压回二值，而 A2A 落地后第三个身份无处可去。
    expect(markup).not.toContain('log-turn--user_message')
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

    // The reply is a turn, on screen, in full — never behind a default-closed disclosure. Identity,
    // not kind, puts it in the conversation register.
    expect(markup).toContain('class="log-turn" data-speaker-role="agent"')
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
    expect(markup).toContain('class="log-turn" data-speaker-role="human"')
    expect(markup).toContain('Actually, focus on the parser instead.')
    expect(markup).toContain('You')
    expect(markup).not.toContain('log-row log-row--user_message')

    // It is bracketed by machine steps, proving it landed mid-turn: the two runs on either side each fold
    // to "2 steps", and the steer sits between them rather than being swept into either.
    const log = markup.slice(markup.indexOf('activity-log'))
    expect(log).toContain('2 steps')
    const turnAt = log.indexOf('data-speaker-role="human"')
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

    // 判据是「没有任何说话人落到对话寄存器」，不是「没有某个 kind 的类名」——后者在形状改成身份
    // 驱动之后会恒为真，也就是一条守不住任何东西的断言。
    expect(markup).not.toContain('data-speaker-role')
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

  /**
   * 上面那条喂的两步既有入参又有输出，都走**可展开**分支。这一条守的是另一支：既无入参又无输出的
   * 失败步骤——它**没有可展开面板**，于是 `data-status` 与 Failed 徽标是它唯一的失败线索。
   *
   * 这个形状真实可达：失败事件普遍不带 output key，而错误文本提取也落空时（如 `{is_error:true}`
   * 且前序事件的 `tool_input` 已丢），`hookToolOutcome` 给出 `{failed:true}`，既无 output 也无
   * toolInput；被拒的 permission 行同形。
   *
   * 实测（在 `*MutantProbe*` 副本上，每次只改一处）：把不可展开那支的徽标条件换成 `false`、或把它的
   * `data-status` 写成常量 `"complete"`，本文件 38 条**全绿**。原因是既有的失败断言喂的是两条连续
   * tool_call，被折成 Run：`log-row__chip--failed` 由 Run 折叠头的徽标满足，`data-status="failed"`
   * 由 ruler 刻度满足；而带 `toolInput` 的那条失败用例走的是可展开分支（那一支确实被守住）。
   * 徽标一侧已随 RowMeta 收成一处，`data-status` 是两个元素上的两个属性、收不成一处，故这条必须在。
   * 而它的判据必须切到行那一段里（`logRowMarkup`）：整份文档的 `data-status="failed"` 会被 ruler
   * 刻度满足——本条第一版就是那么写的，M1（行上的 `data-status` 改成常量）实测 40 条**全绿**存活。
   */
  it('既无入参也无输出的失败步骤，仍然一眼看得出失败', () => {
    const markup = render('complete-events', [
      activity('naked-failure', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash', status: 'failed', createdAt: 1
      })
    ])

    // 先证判据落在**不可展开**那一支上：这一行没有展开入口，否则下面守的就是另一支了。
    expect(markup, '这一步竟然可展开——判据落到了另一个分支上，下面的断言证不了目标那支').not.toContain('data-expandable')
    // 断言落在行自己那一段里：整份文档的 data-status 会被 ruler 刻度满足（见 logRowMarkup 头部注释）。
    const row = logRowMarkup(markup)
    expect(row, '不可展开的失败步骤没有 Failed 徽标：它与成功步骤逐像素相同').toContain('log-row__chip--failed')
    expect(row, '不可展开的失败步骤没有失败状态属性：红点与配色全部退化').toContain('data-status="failed"')
  })

  it('同形的成功步骤不许被标成失败——否则「都一样」只是换了个方向', () => {
    // 反向那一侧。少了它，把两个记号写成无条件渲染也会让上一条通过，而那时人人都是失败。
    const markup = render('complete-events', [
      activity('naked-success', {
        kind: 'tool_call', title: 'Bash', toolName: 'Bash', createdAt: 1
      })
    ])

    expect(markup).not.toContain('data-expandable')
    const row = logRowMarkup(markup)
    expect(row, '成功步骤挂上了 Failed 徽标').not.toContain('log-row__chip--failed')
    expect(row, '成功步骤被标成失败状态').not.toContain('data-status="failed"')
    // 正向取值也要钉：只判「不是 failed」的话，把属性整个删掉也能过，而那时 CSS 一个钩子都没有。
    expect(row, '成功步骤连状态属性都没有：配色与红点的唯一钩子不在了').toContain('data-status="complete"')
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

  /**
   * 全成功的一段折叠**不许**挂 FAILED。
   *
   * 这条是 :523 那条的反向配对，缺了它整个徽标判据只守了一侧：把 `failed` 改成恒真（实测
   * `const failed = true || items.some(...)`）时 47 条全绿，而界面上**每一段**多步折叠都会挂上红色
   * FAILED。这个徽标是折叠态下 SSR 直接可见的那件东西——用户不展开就靠它一眼判断这段有没有出事，
   * 恒真等于把这个判断彻底废掉，且比漏报更坏：它会把注意力引到没有问题的地方。
   */
  it('全成功的折叠段不挂 FAILED——徽标的另一侧', () => {
    const markup = render('complete-events', [
      activity('ok1', {
        kind: 'tool_call', title: 'Read', toolName: 'Read',
        toolInput: '{"file_path":"/a.ts"}', status: 'complete', createdAt: 1, updatedAt: 1
      }),
      activity('ok2', {
        kind: 'tool_call', title: 'Read', toolName: 'Read',
        toolInput: '{"file_path":"/b.ts"}', status: 'complete', createdAt: 2, updatedAt: 2
      })
    ])

    const fold = markup.slice(markup.indexOf('log-fold'))
    // 先证这确实是一段折叠（否则下面的 not 是在一段不存在的标记上恒真）。
    expect(fold).toContain('2 steps')
    expect(fold).not.toContain('log-row__chip--failed')
    expect(fold).not.toContain('FAILED')
  })

  /**
   * 机器行携带的正文（prose）必须真的渲染出来。
   *
   * 这条补的是 tracker #180 同族里**折叠态就可见**的那半：`{prose ? <p className="log-row__prose">…}`
   * 改成 `{false && prose ? …}` 时 47 条全绿，而那行文字在界面上凭空消失。#180 说的
   * `log-row__output` 藏在 `open` 之后属已知的 effect 盲区（renderToStaticMarkup 不跑 effect），
   * prose 不是——它无条件渲染，本来就够得着，所以没人守它纯属真空。
   *
   * fixture 必须落到机器 `Row` 而不是 `Turn`：`source:'native-hook'` 且 kind 不是 assistant_message，
   * 于是 `speakerOf` 返回 null（判据同源，见 conversation-speaker），走 24px 紧凑行那一路。
   */
  it('机器行的正文真的渲染出来，不是只存在于数据里', () => {
    const markup = render('complete-events', [
      activity('note', {
        kind: 'lifecycle',
        source: 'native-hook',
        title: 'Session resumed',
        content: '接回了上次的会话'
      })
    ])

    // 走的是机器行那一路——不是 turn register。
    expect(markup).toContain('log-row--lifecycle')
    expect(markup).not.toContain('log-turn')
    // 正文本体在场：类名与那段字各钉一次，只钉类名的话把 <p> 留着而内容换掉不会红。
    expect(markup).toContain('log-row__prose')
    expect(markup).toContain('接回了上次的会话')
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

  /**
   * 用户：「关于 Active View，User 发的消息要单独显示，而且时间只显示分钟太不友好了, 应该显示从
   * 什么时间点到什么时间点, 消耗的时分秒」。
   *
   * 纯函数那一侧在 activity-ruler-mapping.test.ts 里验收；这一组守的是**接线**——三个格式化器写对
   * 了却没人在 View 里调用，两边的测试都会绿。
   */
  describe('时刻与耗时接到界面上', () => {
    // 用本地时间构造，于是断言与跑测试的时区无关。
    const at = (h: number, m: number, s: number): number => new Date(2026, 0, 2, h, m, s).getTime()

    it('标尺头上给出起、止、耗时三件，而不是一个偏移量', () => {
      // 一次跑了 3 小时的 Session：这正是用户报的那个形状。
      const markup = render('complete-events', [
        activity('a', { createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0) }),
        activity('b', { createdAt: at(17, 4, 3), updatedAt: at(17, 4, 3) })
      ])
      const head = markup.slice(markup.indexOf('activity-ruler__span'), markup.indexOf('activity-ruler__note'))
      // 两个真实时刻。它们回答的是「从什么时间点到什么时间点」，偏移量答不了。断言的是**可见文本
      // 节点**而不是这一段切片：同元素的 title 里也复制了这三个值，落在切片上的 toContain 分不出
      // "可见读数渲染了"与"只剩一个 title"。
      expect(head).toContain('>14:00:00<')
      expect(head).toContain('>17:04:03<')
      // 以及耗时，带小时位。
      expect(head).toContain('>3h04m03s<')
      // 三件各自摆在自己那一格里，而不是挤成一串文本。
      expect(head).toContain('activity-ruler__span-range')
      expect(head).toContain('activity-ruler__span-elapsed')
      // 反向：分钟封顶那个实现给的是 `184m03s`，它不许出现在界面上任何位置（含 title）。
      expect(markup).not.toContain('184m03s')
    })

    it('序数轴上不渲染跨度——那条轴上没有流逝的时间可报', () => {
      const markup = render('complete-events', [
        activity('a', { createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0) }),
        activity('b', { createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0) })
      ])
      expect(markup).toContain('data-axis="ordinal"')
      // 整个 span 那一件都不在——不是"渲染了一个 0s"，是根本不渲染。
      expect(markup).not.toContain('activity-ruler__span')
      expect(markup).not.toContain('elapsed')
    })

    it('一句话的时间是它说话的时刻，偏移量降进 title', () => {
      const markup = render('complete-events', [
        activity('ask', {
          kind: 'user_message', source: 'user', title: 'Prompt',
          content: '开始吧', createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0)
        }),
        activity('reply', {
          kind: 'assistant_message', source: 'native-hook',
          content: '好', createdAt: at(17, 4, 3), updatedAt: at(17, 4, 3)
        })
      ])
      const log = markup.slice(markup.indexOf('activity-log'))
      // 可见的那一列是时刻：「什么时候说的」才是一句话关心的问题。
      expect(log).toContain('>17:04:03</span>')
      // 而距开始多久没有丢，它退进 title——两个事实都答得出而只占一列宽。
      expect(log).toContain('title="17:04:03 · +3h04m03s from start"')
    })

    it('折起来的一段机器执行报出它藏掉的那段时间', () => {
      const markup = render('complete-events', [
        activity('u', {
          kind: 'user_message', source: 'user', content: '跑', createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0)
        }),
        activity('t1', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
          createdAt: at(14, 0, 1), updatedAt: at(14, 0, 2)
        }),
        activity('t2', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
          createdAt: at(14, 2, 5), updatedAt: at(14, 2, 6)
        })
      ])
      const fold = markup.slice(markup.indexOf('log-fold'))
      expect(fold).toContain('2 steps')
      // 从首条开始到末条完成共 2m05s：这个数就摆在 "N steps" 旁边，展开与否都在同一位置回答
      // "这一段值不值得展开"。
      expect(fold).toContain('log-fold__elapsed')
      expect(fold).toContain('2m05s')
    })

    it('跨度算到末步跑完，不是算到末步开始', () => {
      // 回归：跨度曾取首末两条的 createdAt 之差，于是末步自己跑了多久整段漏掉。一段执行的末步往往
      // 是最贵的那一步——下面这段的末步跑了 5 分钟，而两步的**开始**只隔 1 秒。旧实现会宣称这段
      // 只有 1.0s，把它藏着的五分钟构建说成一瞬间。
      const markup = render('complete-events', [
        activity('u', {
          kind: 'user_message', source: 'user', content: '跑', createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0)
        }),
        activity('t1', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
          createdAt: at(14, 0, 0), updatedAt: at(14, 0, 1)
        }),
        activity('t2', {
          kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: 'pnpm build',
          createdAt: at(14, 0, 1), updatedAt: at(14, 5, 0)
        })
      ])
      const fold = markup.slice(markup.indexOf('log-fold'))
      expect(fold).toContain('5m00s')
      expect(fold).not.toContain('1.0s')
    })

    it('并发的几步里取最后完成的那个，不是数组里最后那条', () => {
      // 完成顺序不必跟着开始顺序：并发跑的两步，先开始的可能后结束。取 max 而不是末条的 updatedAt。
      const markup = render('complete-events', [
        activity('u', {
          kind: 'user_message', source: 'user', content: '跑', createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0)
        }),
        activity('t1', {
          kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: 'pnpm test',
          createdAt: at(14, 0, 0), updatedAt: at(14, 3, 0)
        }),
        activity('t2', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
          createdAt: at(14, 0, 1), updatedAt: at(14, 0, 2)
        })
      ])
      const fold = markup.slice(markup.indexOf('log-fold'))
      expect(fold).toContain('3m00s')
    })

    it('同一时刻的一段不硬报 0s', () => {
      // 折叠头的跨度从首条开始算到末步跑完。整段都落在同一时刻——每一步都是瞬时完成——那就没有时间
      // 可报，此时不渲染那一件：与序数轴同一条诚实规则，不给一个读起来像"瞬间完成"的 `0s`。
      const markup = render('complete-events', [
        activity('u', {
          kind: 'user_message', source: 'user', content: '跑', createdAt: at(14, 0, 0), updatedAt: at(14, 0, 0)
        }),
        activity('t1', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'a.ts',
          createdAt: at(14, 0, 1), updatedAt: at(14, 0, 1)
        }),
        activity('t2', {
          kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: 'b.ts',
          createdAt: at(14, 0, 1), updatedAt: at(14, 0, 1)
        })
      ])
      const fold = markup.slice(markup.indexOf('log-fold'))
      expect(fold).toContain('2 steps')
      expect(fold).not.toContain('log-fold__elapsed')
    })
  })
})

// ---------------------------------------------------------------------------
// 失败的**回合**在界面上与成功的不一样。
//
// 机器行那一路早就守住了（:492 那条，两条 tool_call 一成一败）。回合这一路两侧都真空：把
// `data-status={item.status}` 整段从 Turn 上删掉、或把 Failed 徽标改成 `false && …`，desktop
// 全量都全绿（各自实测 92 / 83 条，含 activity-view + wiring + 轴 + session-pane 四个文件）。
// 后果是「Agent 这一轮出错了」在对话里与成功**完全相同**：头像节点不变红、无徽标、正文照常渲染，
// 于是一次失败的回合读起来就是一次正常回答。
//
// 为什么现有断言碰不到：:256 那条 `toContain('Failed')` 命中的是同一批 items 里那条 acp
// **tool_call**（机器行），不是回合；把回合的徽标删掉，那条照旧被机器行满足。这正是本仓记过的
// 「抽查的那一对可能正是盲点」——判据必须落在**只有回合会渲染**的那段标记里。
//
// 可达性先证再写：`session-timeline.ts:263` 的 ACP append 把 `kind` 与 `status` 各自原样透传
// （`:274` 的 update 更是只改 status 不碰 kind），所以 `assistant_message` × `failed` 是合同允许
// 的组合；实测渲染确实产出 `class="log-turn" … data-status="failed"`。不是死代码。
// ---------------------------------------------------------------------------

/** 失败的 Agent 回合：进程给了话，但这一轮的结局是失败。 */
const failedTurn = activity('reply-failed', {
  kind: 'assistant_message',
  source: 'native-hook',
  status: 'failed',
  content: 'I could not finish.',
  createdAt: 1,
  updatedAt: 1
})

/** 同一形状、只有结局不同的成功回合——反向那一侧。 */
const okTurn = activity('reply-ok', {
  kind: 'assistant_message',
  source: 'native-hook',
  content: 'Done.',
  createdAt: 2,
  updatedAt: 2
})

/** 只取回合那一段标记：机器行的徽标不许替回合作担保（见本块头部注释）。 */
function turnMarkup(markup: string): string {
  const start = markup.indexOf('class="log-turn"')
  expect(start, '没渲染出回合——判据落空了，下面的断言会变成恒真').toBeGreaterThanOrEqual(0)
  return markup.slice(start)
}

describe('失败的对话回合与成功的不一样', () => {
  it('失败的回合带 data-status 与 Failed 徽标，成功的两样都没有', () => {
    // 一次渲染里同时放一成一败：这样「两边长得一样」的退化写法（无论是恒不标还是恒标）都会红。
    const markup = render('complete-events', [failedTurn, okTurn])
    const turns = turnMarkup(markup)

    // 失败那一侧。`data-status` 是 CSS 把头像节点变红的唯一钩子（见下一条），徽标是不依赖颜色的
    // 那一半——色盲用户与深色主题下颜色对比不足时，徽标是唯一还在说话的东西，所以两件都要。
    expect(turns).toContain('data-status="failed"')
    expect(turns).toContain('log-row__chip--failed')
    expect(turns).toContain('Failed')

    // 反向那一侧：成功的回合不许也被标成失败，否则「区分」退化成「全都报错」。
    expect(turns).toContain('data-status="complete"')
    expect(turns.match(/log-row__chip--failed/g)).toHaveLength(1)
  })

  it('失败的回合不靠正文自己说——正文可能压根没提失败', () => {
    // 判据不能是「文案里有没有出现 error 字样」：一轮失败的回合完全可能只留下一句普通的话，
    // 甚至什么都没留下（content 缺席）。状态是**结构**上的事实，不是正文的措辞。
    const markup = render('complete-events', [
      activity('quiet-fail', {
        kind: 'assistant_message',
        source: 'native-hook',
        status: 'failed',
        content: 'Sure, let me look at that.',
        createdAt: 1,
        updatedAt: 1
      })
    ])
    const turns = turnMarkup(markup)
    expect(turns).toContain('data-status="failed"')
    expect(turns).toContain('Failed')
  })

  it('把 Failed 徽标从回合上删掉时，机器行那条断言不许替它作担保', () => {
    // 自检：证明本族的判据真的落在回合上。这一次渲染里**只有回合**，没有任何 tool_call——
    // 于是 :256 那条靠机器行满足的 `toContain('Failed')` 在这里无从借力。
    const markup = render('complete-events', [failedTurn])
    expect(markup).not.toContain('log-row log-row--')
    expect(markup).toContain('Failed')
  })

  it('样式表里真有那条把失败回合画红的规则，不只是选择器名在场', () => {
    // 本仓栽过「CSS 守卫只查选择器名存在：删掉承重声明体全绿」。`data-status` 带真实取值，
    // 不在 rendered-class-has-rule 的「在场标志」判据范围内（那条只管 '' / undefined 二态的属性），
    // 所以这一格没有别人守。这里连声明体一起钉：规则在、且真的改了颜色。
    const rule = allStyles().match(/\.log-turn\[data-status='failed'\][^{]*\{([^}]*)\}/)
    expect(rule, '失败回合的着色规则不在样式表里——头像节点不会变红').not.toBeNull()
    expect(rule![1]).toMatch(/color\s*:/)
  })
})
