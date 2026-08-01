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

  // 这一组不用 spy：标题是**折叠态就渲染出来的文本**，静态渲染够得着，直接断言成果比断言
  // "某个函数被调用了"更强——后者在渲染结果被丢弃时仍会绿。
  it('折叠着的一行带上那条命令，不用展开就知道跑了什么', () => {
    const markup = render([activity('run', {
      kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'pnpm test' })
    })])

    expect(markup).toContain('pnpm test')
  })

  it('读不到参数时只显示工具名，不显示空壳', () => {
    const markup = render([activity('run', {
      kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: '{bad'
    })])

    expect(markup).toContain('Bash')
    expect(markup).not.toContain('Bash ()')
    expect(markup).not.toContain('Bash undefined')
    expect(markup).not.toContain('Bash null')
  })

  it('重复合并与 Failed chip 不因摘要而退化——这是我们既有的优势', () => {
    // 注意：连续的机器步骤会被折成一个 fold，折起来时里面的行不渲染，所以这里断言的是
    // fold 自己那层（N steps / M unique / FAILED），而不是里面某一行的摘要。
    const step = (id: string, createdAt: number) => activity(id, {
      kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'ls -la' }), createdAt, updatedAt: createdAt
    })
    const markup = render([
      activity('ask', { kind: 'user_message', source: 'user', title: 'Prompt', content: 'go', createdAt: 1 }),
      step('h1', 2), step('h2', 3), step('h3', 4)
    ])

    expect(markup).toContain('3 steps')
    expect(markup).toContain('1 unique')
  })

  it('未被折叠的单步仍然带上摘要，且 Failed chip 还在', () => {
    // 单独一步不进 fold（见 segment 的注释），因此它的标题就是折叠态下用户直接看到的文本。
    const markup = render([
      activity('ask', { kind: 'user_message', source: 'user', title: 'Prompt', content: 'go', createdAt: 1 }),
      activity('bad', {
        kind: 'tool_call', status: 'failed', source: 'acp', title: 'Run tests',
        toolName: 'Bash', toolInput: JSON.stringify({ command: 'pnpm test' }), createdAt: 2, updatedAt: 2
      })
    ])

    expect(markup).toContain('pnpm test')
    expect(markup).toContain('Failed')
  })
})

describe('「在进行」指示接线', () => {
  const working = (items: AgentTimelineItem[]): string =>
    renderToStaticMarkup(createElement(ActivityView, {
      capability: 'streaming' as const, items, displayState: 'working' as const
    }))

  it('刚发完 prompt、还没有条目时显示「在进行」而不是空状态——今天最刺眼的那一幕', () => {
    const markup = working([])

    expect(markup).toContain('Working')
    expect(markup).not.toContain('No structured activity yet')
  })

  it('指示对辅助技术可感知，不是纯视觉动画', () => {
    const markup = working([])

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })

  it('只有工具步骤、还没有正文时指示还在', () => {
    const markup = working([activity('t', {
      kind: 'tool_call', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: '{}'
    })])

    expect(markup).toContain('Working')
  })

  it('助手正文一到就退场，不与正文并存造成两个「在动」的信号', () => {
    const markup = working([activity('reply', { content: 'Here is the plan' })])

    expect(markup).toContain('Here is the plan')
    expect(markup).not.toContain('role="status"')
  })

  it('没在工作、也没有条目时仍是空状态，且两种空因保持可区分', () => {
    // 「此 Provider 不报结构化活动」与「还没有活动」是两回事——这是既有的优点，不许退化成一句话。
    const idle = renderToStaticMarkup(createElement(ActivityView, {
      capability: 'streaming' as const, items: [], displayState: 'done' as const
    }))
    expect(idle).toContain('No structured activity yet')
    expect(idle).not.toContain('role="status"')

    const unavailable = renderToStaticMarkup(createElement(ActivityView, {
      capability: 'unavailable' as const, items: [], displayState: 'working' as const
    }))
    // 能力缺失优先于"在进行"：Provider 根本不报，就不该假装它在报。
    expect(unavailable).toContain('does not provide structured activity')
    expect(unavailable).not.toContain('role="status"')
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

  /**
   * 没截断就**不许**说截断了。
   *
   * 上面那条只守了「该出现时出现」；把提示改成无条件渲染（`{true ? …}`）时 15 条全绿，而任何一次
   * 完整的短 diff 都会显示 "Diff truncated at 200 lines."——用户以为自己漏看了行，去别处找不存在的
   * 剩余内容。一条判据的两侧必须各有一条测试，这是本仓反复出现的「只守一侧」形状。
   */
  it('没截断就不说截断——提示的另一侧', () => {
    const markup = renderToStaticMarkup(createElement(DiffBlock, {
      diff: {
        lines: [
          { kind: 'removed' as const, text: 'const a = 1' },
          { kind: 'added' as const, text: 'const a = 2' }
        ],
        truncated: false
      }
    }))

    // 先证 diff 本体真的渲染了，否则下面的 not 是在空输出上恒真。
    expect(markup).toContain('log-diff__line--added')
    expect(markup).not.toContain('log-diff__truncated')
    expect(markup).not.toContain('truncated')
  })
})
