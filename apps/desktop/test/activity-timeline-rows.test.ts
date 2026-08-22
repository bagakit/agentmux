/**
 * 折叠规则的单测。
 *
 * 这个文件存在的理由：一次工具调用发两个 hook（Pre 落入参、Post 落结果），旧折叠比的是
 * kind/title/toolInput，这两行完全一致，于是折成一行并**保留排在前面的那条**——也就是没有结果
 * 的那条。采集层再对，用户看到的还是入参。这类"接线处静默失效"是本仓库反复栽的坑。
 */

import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { timelineRows } from '../src/renderer/src/lib/activity-timeline-rows.js'

function step(overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return {
    id: 'item-1',
    agentSessionId: 'session-1',
    kind: 'tool_call',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1,
    updatedAt: 1,
    title: 'Bash',
    toolName: 'Bash',
    toolInput: '{"command":"ls"}',
    ...overrides
  }
}

describe('时间轴折叠', () => {
  it('同一步的入参行与结果行折成一行，留下带结果的那条', () => {
    // 留错了这一条，用户点开看到的永远是入参，输出与失败全被吃掉——而采集层的用例照样全绿。
    const rows = timelineRows([
      step({ id: 'pre' }),
      step({ id: 'post', toolOutput: 'total 24' })
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.item.id).toBe('post')
    expect(rows[0]!.item.toolOutput).toBe('total 24')
  })

  it('失败事实也算结果——带失败的那条要赢', () => {
    // 顺序是**故意**把失败那条放在前面的：放在后面的话，「都没结果时后来者为准」这条兜底会
    // 恰好也给出正确答案，于是"失败算不算结果"这个判断被架空，改坏了测试也不会红。
    const rows = timelineRows([
      step({ id: 'post', status: 'failed' }),
      step({ id: 'stray-pre' })
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.item.id).toBe('post')
    expect(rows[0]!.item.status).toBe('failed')
  })

  it('没结果的那条绝不顶掉有结果的，哪怕它来得更晚', () => {
    // 事件乱序或 Provider 多发一次事前事件时，不许把已经拿到的结果覆盖回去。
    const rows = timelineRows([
      step({ id: 'post', toolOutput: 'total 24' }),
      step({ id: 'stray-pre' })
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.item.toolOutput).toBe('total 24')
  })

  it('真正的重复仍然折叠计数——这是折叠原本要解决的噪音', () => {
    const rows = timelineRows([step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(3)
  })

  it('不同的步骤不折叠', () => {
    const rows = timelineRows([
      step({ id: 'a', toolInput: '{"command":"ls"}' }),
      step({ id: 'b', toolInput: '{"command":"pwd"}' })
    ])

    expect(rows).toHaveLength(2)
  })

  it('只有相邻的才折叠——中间隔了别的步骤就是两次独立执行', () => {
    const rows = timelineRows([
      step({ id: 'a' }),
      step({ id: 'other', title: 'Read', toolInput: '{"file_path":"/a.ts"}' }),
      step({ id: 'b' })
    ])

    expect(rows).toHaveLength(3)
  })

  it('空时间轴给空列表，不报错', () => {
    expect(timelineRows([])).toEqual([])
  })

  it('相邻的用户消息各自保留，不被同名的机器步骤折叠规则吃掉', () => {
    const rows = timelineRows([
      step({ id: 'prompt-1', kind: 'user_message', source: 'user', title: 'Prompt', toolInput: undefined, content: '第一句' }),
      step({ id: 'prompt-2', kind: 'user_message', source: 'user', title: 'Prompt', toolInput: undefined, content: '第二句' })
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.item.content)).toEqual(['第一句', '第二句'])
    expect(rows.every((row) => row.count === 1)).toBe(true)
  })
})
