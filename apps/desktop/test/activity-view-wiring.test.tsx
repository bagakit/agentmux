import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 判定本身在 activity-diff.test.ts / activity-autoscroll.test.ts 里测过了。
// 这一层只回答一个问题：**它们真的被 ActivityView 调用了吗**。
// 本仓库栽过这个跟头——判定写对了、纯函数测试全绿，但组件里那行调用被删掉也没人变红。
// 手法：把两个 lib 换成 spy，渲染一次真组件，断言调用确实发生、且传进去的是真实的入参。
// renderToStaticMarkup 不跑 effect，但 useMemo 与 useRef 初始化是**渲染期**执行的，够得着。

const diffSpy = vi.hoisted(() => ({
  toolCallToDiff: vi.fn(() => null as unknown),
  parseUnifiedDiff: vi.fn(() => null as unknown)
}))
const followSpy = vi.hoisted(() => ({ initFollowState: vi.fn(() => ({ following: true, lastScrollTop: 0, lastSignature: { itemCount: 0, lastItemId: null, lastItemLength: 0 } })) }))

vi.mock('../src/renderer/src/lib/activity-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/activity-diff.js')>()
  return {
    ...actual,
    toolCallToDiff: (...args: Parameters<typeof actual.toolCallToDiff>) => {
      diffSpy.toolCallToDiff(...(args as never[]))
      return actual.toolCallToDiff(...args)
    },
    parseUnifiedDiff: (...args: Parameters<typeof actual.parseUnifiedDiff>) => {
      diffSpy.parseUnifiedDiff(...(args as never[]))
      return actual.parseUnifiedDiff(...args)
    }
  }
})

vi.mock('../src/renderer/src/lib/activity-autoscroll.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/activity-autoscroll.js')>()
  return {
    ...actual,
    initFollowState: () => {
      followSpy.initFollowState()
      return actual.initFollowState()
    }
  }
})

import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ActivityView, DiffBlock } from '../src/renderer/src/components/ActivityView.js'

function activity(id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
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

function render(items: AgentTimelineItem[]): string {
  return renderToStaticMarkup(createElement(ActivityView, { capability: 'streaming' as const, items }))
}

const EDIT_INPUT = JSON.stringify({
  file_path: '/repo/src/a.ts',
  old_string: 'const a = 1',
  new_string: 'const a = 2'
})

afterEach(() => {
  diffSpy.toolCallToDiff.mockClear()
  diffSpy.parseUnifiedDiff.mockClear()
  followSpy.initFollowState.mockClear()
})

describe('对话体接线', () => {
  it('一次 Edit 调用真的被送去算 diff——删掉那行调用这里会红', () => {
    render([activity('edit', {
      kind: 'tool_call', source: 'native-hook', title: 'Write file', toolName: 'Write', toolInput: EDIT_INPUT
    })])

    // 传进去的必须是**这一行自己的工具名 + 真实入参**，不是写死的常量：把 item.title 换成
    // 'Edit' 这类固定值，这条会红。用 'Write file' 作标题正是为了让常量替换露馅。
    expect(diffSpy.toolCallToDiff).toHaveBeenCalledWith('Write file', EDIT_INPUT)
  })

  it('非编辑类的 payload 会退到 unified-diff 识别，而不是直接当原文', () => {
    // 这条守的是那个 `??` 回退：只调 toolCallToDiff、不接 parseUnifiedDiff，
    // ```diff 围栏与 unified-diff 形状的文本就永远着不上色。
    render([activity('note', {
      kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'bash', toolInput: 'ls -la'
    })])

    expect(diffSpy.parseUnifiedDiff).toHaveBeenCalledWith('ls -la')
  })

  it('没有 payload 的行不去算 diff——不为一条纯文字回复白跑一趟', () => {
    render([activity('reply', { content: 'Working on it' })])

    expect(diffSpy.toolCallToDiff).not.toHaveBeenCalled()
    expect(diffSpy.parseUnifiedDiff).not.toHaveBeenCalled()
  })

  it('跟随状态在挂载时就建立——删掉 initFollowState 这行会红', () => {
    render([activity('reply', { content: 'Working on it' })])

    expect(followSpy.initFollowState).toHaveBeenCalled()
  })
})

// 展开态藏在 useState 后面，而本仓库没有能跑 effect / 触发事件的 harness，所以"展开后长什么样"
// 只能直接渲染 DiffBlock 来断言。这一层守的是**渲染成果**：加删行各自有自己的类名与 +/- 字符槽。
// 注意它守不住"Row 里那行 <DiffBlock> 是否还在"——把它换回原来的 <pre> 不会让任何测试变红。
// 这是当前 harness 的已知缺口，不是被忽略的疏漏。
describe('DiffBlock 渲染', () => {
  it('加删行分别带类名，且各有一个 +/- 字符槽——颜色不是唯一载体', () => {
    const markup = renderToStaticMarkup(createElement(DiffBlock, {
      diff: {
        lines: [
          { kind: 'removed' as const, text: 'const a = 1' },
          { kind: 'added' as const, text: 'const a = 2' },
          { kind: 'context' as const, text: 'return a' }
        ],
        truncated: false,
        filePath: '/repo/src/a.ts'
      }
    }))

    expect(markup).toContain('log-diff__line--removed')
    expect(markup).toContain('log-diff__line--added')
    expect(markup).toContain('/repo/src/a.ts')
    // 转义 JSON 的原貌不该再出现：这正是用户抱怨的那个形状。
    expect(markup).not.toContain('old_string')
    // 字符槽：色觉差异或高对比模式下仍读得出增删。
    expect(markup).toContain('>+<')
    expect(markup).toContain('>-<')
  })

  it('截断了就说出来——静默截断会让用户以为看到了全部', () => {
    const markup = renderToStaticMarkup(createElement(DiffBlock, {
      diff: { lines: [{ kind: 'added' as const, text: 'x' }], truncated: true }
    }))

    expect(markup).toContain('truncated')
  })
})
