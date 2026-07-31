import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { createRulerScale } from '../src/renderer/src/lib/activity-ruler.js'
import {
  conversationAxis,
  speaksAsAgent,
  speaksAsHuman
} from '../src/renderer/src/lib/conversation-axis.js'

/**
 * 两条轴（说话人轴、自我 Agent 轴）收敛成一个纯函数之后，这里钉的是那个函数的四条验收：
 * 复用 ruler 时间基准且序数退化仍有效、轴语义是参数而非分支复制、只收该轴身份的发言且不吞机器
 * 上报、每个标记都能反查回它那条 timeline item。
 *
 * 这些性质写在纯函数上而不是渲染断言上是有原因的：本仓渲染测试用 `renderToStaticMarkup`，轴的
 * 定位与筛选只能通过 class 名与 style 间接观察，而「位置按哪条时间基准算」「谁被收进来」这种判断
 * 在 markup 上分辨不出——两种实现能给出一样的 DOM，却在时间基准或身份筛选上行为相反。
 */
function item(overrides: Partial<AgentTimelineItem>): AgentTimelineItem {
  return {
    id: 'item-1',
    agentSessionId: 'agent-1',
    kind: 'lifecycle',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Event',
    ...overrides
  }
}

/**
 * 一条真实节奏的时间轴：人说话 → 若干机器上报（时间戳不均匀）→ Agent 回话 → 人再说话。
 * 关键是时间戳不均匀，且人类两条发言之间夹着机器步骤——这样「在全量上建 scale 按原始下标取位」
 * 与「在筛过的子集上建 scale」会给出**不同**的位置，能钉住时间基准同源这条。
 */
function conversationFixture(): AgentTimelineItem[] {
  return [
    item({ id: 'u1', source: 'user', kind: 'user_message', createdAt: 0, content: '第一句问' }),
    item({ id: 't1', kind: 'tool_call', source: 'native-hook', createdAt: 250 }),
    item({ id: 't2', kind: 'tool_call', source: 'native-hook', createdAt: 300 }),
    item({ id: 'a1', kind: 'assistant_message', source: 'native-hook', createdAt: 1_000, content: 'Agent 的答' }),
    item({ id: 'u2', source: 'user', kind: 'user_message', createdAt: 4_000, content: '第二句问' })
  ]
}

describe('对话体两条轴的定位与筛选', () => {
  it('说话人轴只收人类发言，且带回原始下标与那条 item', () => {
    // 说话人轴今天只会有人类用户的发言（设计 SSOT）。这条钉住：只有两条 user 发言进轴，机器步骤与
    // Agent 回话都不在其上；且每个标记带的是**原始**下标（u1=0、u2=4），不是筛选后子集里的 0/1。
    const items = conversationFixture()
    const marks = conversationAxis(items, speaksAsHuman)
    expect(marks.map((m) => m.item.id)).toEqual(['u1', 'u2'])
    expect(marks.map((m) => m.index)).toEqual([0, 4])
    for (const mark of marks) expect(mark.speaker.role).toBe('human')
  })

  it('自我 Agent 轴只收该 Agent 说话的位置', () => {
    // 同一批 item，换一个轴语义参数就得出另一条轴——这半边钉「轴语义是参数」。这条轴上只有 a1，
    // 两条人类发言不在其上。
    const items = conversationFixture()
    const marks = conversationAxis(items, speaksAsAgent)
    expect(marks.map((m) => m.item.id)).toEqual(['a1'])
    expect(marks.map((m) => m.index)).toEqual([3])
    expect(marks[0]!.speaker.role).toBe('agent')
  })

  it('两条轴由同一函数以不同参数得出，代码里不存在两份定位算法', () => {
    // 这条是「轴语义是参数而非分支复制」的正面钉子（配合下一条从反面钉）。同一个 items，两条轴的
    // 标记集合必须**不同**——若有人把轴语义写死成同一个，两条轴会给出同一批标记，这条立刻红。
    const items = conversationFixture()
    const human = conversationAxis(items, speaksAsHuman).map((m) => m.item.id)
    const agent = conversationAxis(items, speaksAsAgent).map((m) => m.item.id)
    expect(human).not.toEqual(agent)
    // 两条轴合起来恰好是全部对话发言（人类 + Agent），机器上报一条都不在内。
    expect([...human, ...agent].sort()).toEqual(['a1', 'u1', 'u2'])
  })

  it('位置按全量时间基准算，而不是筛过的子集——两条轴时间基准同源', () => {
    // 这条是最微妙的验收。说话人轴上是 u1(0ms) 与 u2(4000ms)，但它们中间夹着机器步骤，全量最后一条
    // 也是 u2。若在全量 items（0,250,300,1000,4000）上建 scale，u2 的分数是 4000/4000=1；若错误地
    // 在筛过的子集（只剩 0,4000）上建 scale，u2 的分数**同样**是 1，分辨不出。所以要看 u1 之外还需
    // 一个「全量位置≠子集位置」的证据：这里直接拿全量 scale 对照，钉死每个标记的 fraction 必须等于
    // 全量 scale 在其原始下标处的值。任何在子集上重建 scale 的实现都会在某个标记上偏离。
    const items = conversationFixture()
    const fullScale = createRulerScale(items.map((i) => i.createdAt), 1)
    const marks = conversationAxis(items, speaksAsHuman)
    for (const mark of marks) {
      expect(mark.fraction).toBeCloseTo(fullScale.fractionOf(mark.index), 10)
    }
    // 具体值：u1 在起点，u2 在 4000/4000 处。子集 scale 会把 u1 也放 0、u2 放 1，看着一样——真正的
    // 差别在自我 Agent 轴：a1 原始下标 3、createdAt 1000，全量分数 1000/4000=0.25。子集只有 a1 一条
    // 时 scale 退化、fractionOf(0)=0，与 0.25 明显不同。
    const agentMarks = conversationAxis(items, speaksAsAgent)
    expect(agentMarks).toHaveLength(1)
    expect(agentMarks[0]!.fraction).toBeCloseTo(0.25, 10)
    expect(agentMarks[0]!.fraction).not.toBeCloseTo(0, 6)
  })

  it('机器上报不进任何一条轴——按 source 认人，tool_call/permission/lifecycle 都被挡在外', () => {
    // 机器上报既不是人说话也不是 Agent 说话。它们在 speakerOf 处返回 null，两条轴都不该收。特别构造
    // 一条 source 非 user 的 lifecycle（真实的机器上报），确认它不在任何一条轴上。
    const items = [
      item({ id: 'u1', source: 'user', kind: 'user_message', createdAt: 0 }),
      item({ id: 'perm', kind: 'permission', source: 'native-hook', createdAt: 100 }),
      item({ id: 'life', kind: 'lifecycle', source: 'native-hook', createdAt: 200 }),
      item({ id: 'tool', kind: 'tool_call', source: 'native-hook', createdAt: 300 }),
      item({ id: 'a1', kind: 'assistant_message', source: 'native-hook', createdAt: 400 })
    ]
    const onAnyAxis = new Set([
      ...conversationAxis(items, speaksAsHuman).map((m) => m.item.id),
      ...conversationAxis(items, speaksAsAgent).map((m) => m.item.id)
    ])
    expect(onAnyAxis.has('perm')).toBe(false)
    expect(onAnyAxis.has('life')).toBe(false)
    expect(onAnyAxis.has('tool')).toBe(false)
    // 而两条真发言仍在。
    expect(onAnyAxis.has('u1')).toBe(true)
    expect(onAnyAxis.has('a1')).toBe(true)
  })

  it('每个标记都能反查回它那条 timeline item，hover 面板据此取原话', () => {
    // 验收 4：标记必须带回原始 item，且是**同一个对象**（面板要逐字读它的 content）。若实现只带 id
    // 或索引、把 item 丢了，这条会红。
    const items = conversationFixture()
    const marks = conversationAxis(items, speaksAsHuman)
    expect(marks[0]!.item).toBe(items[0])
    expect(marks[0]!.item.content).toBe('第一句问')
    expect(marks[1]!.item.content).toBe('第二句问')
  })

  it('无跨度时跟随 ruler 退化为序数——位置按序均匀，不堆在左边', () => {
    // 验收 1 的退化路径：所有事件同一时刻，scale 退化为序数，本轴跟着退化，无需另写一套。三条人类
    // 发言应均匀落在 0、0.5、1，而不是全挤在 0（那是「跨度为 0 时误用时间差」的形态）。
    const items = [
      item({ id: 'u1', source: 'user', kind: 'user_message', createdAt: 7 }),
      item({ id: 'u2', source: 'user', kind: 'user_message', createdAt: 7 }),
      item({ id: 'u3', source: 'user', kind: 'user_message', createdAt: 7 })
    ]
    const marks = conversationAxis(items, speaksAsHuman)
    expect(marks.map((m) => m.fraction)).toEqual([0, 0.5, 1])
    // 退化轴上标记不带任何时刻——诚实的时刻只在原始 item 里，本函数不制造 `at`。
    for (const mark of marks) expect((mark as { at?: number }).at).toBeUndefined()
  })

  it('人类发言即便 kind 不是 user_message 也按 source 收进说话人轴', () => {
    // 与 speakerOf 同一条判据：权威是 source 不是 kind。构造一条 source='user' 而 kind 非 user_message
    // 的发言，它必须进说话人轴——按 kind 反推身份的实现会把它漏掉。
    const items = [item({ id: 'u1', source: 'user', kind: 'lifecycle', createdAt: 0 })]
    const marks = conversationAxis(items, speaksAsHuman)
    expect(marks.map((m) => m.item.id)).toEqual(['u1'])
  })

  it('空输入不抛，返回空标记', () => {
    // 纯函数的边界承诺。
    expect(conversationAxis([], speaksAsHuman)).toEqual([])
  })
})
