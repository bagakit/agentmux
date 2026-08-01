import { describe, expect, it, vi } from 'vitest'

// clipboard-copy（formatPathsForCopy 的所在）在模块顶层 import 了 api，而 api.ts 顶层引用了
// Vite 注入的 __AGENTMUX_WEB_PREVIEW__ 常量，plain vitest 里不存在。给它一个不被本组用到的桩。
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { ui: { writeClipboardText: vi.fn(async () => {}) } }
}))

import {
  EDITOR_COPY_ACTIONS,
  MULTILINE_SELECTION_CONTEXT_KEY,
  formatAgentContextBlock,
  hasMultilineSelection,
  type CopyActionInput
} from '../src/renderer/src/lib/editor-copy-actions.js'

// 编辑器右键复制动作的**定义层**。这一组守「每个动作产出什么文本」与「谁在什么条件下出现」，
// 都用纯函数/纯数据，能被直接断言——注册进 Monaco 的那一半由 editor-copy-wiring.test.tsx 守。
//
// 期望文本全部锚成写死的字面量，绝不由被测对象自己算（本仓实测过的恒真陷阱）。

/** 备齐全套原料；每条用例只在乎其中几项，其余给稳定占位值。 */
function input(overrides: Partial<CopyActionInput> = {}): CopyActionInput {
  return {
    relativePath: 'src/app.ts',
    workspaceRoot: '/work',
    startLine: 12,
    endLine: 12,
    selectedText: '',
    fenceLang: 'typescript',
    ...overrides
  }
}

function actionById(id: string) {
  const action = EDITOR_COPY_ACTIONS.find((entry) => entry.id === id)
  if (!action) throw new Error(`no action ${id}`)
  return action
}

describe('复制路径两个变体走的是 formatPathsForCopy 的绝对/相对', () => {
  it('绝对：文件相对路径接到工作区根上', () => {
    expect(actionById('agentmux.copyAbsolutePath').buildText(input())).toBe('/work/src/app.ts')
  })

  it('相对：原样', () => {
    expect(actionById('agentmux.copyRelativePath').buildText(input())).toBe('src/app.ts')
  })

  it('绝对与相对绝不互为别名——搞反必然红', () => {
    const abs = actionById('agentmux.copyAbsolutePath').buildText(input())
    const rel = actionById('agentmux.copyRelativePath').buildText(input())
    expect(abs).toBe('/work/src/app.ts')
    expect(rel).toBe('src/app.ts')
    expect(abs).not.toBe(rel)
  })
})

describe('复制路径:行号', () => {
  it('取起始行，产出「相对路径:行号」', () => {
    expect(actionById('agentmux.copyPathWithLine').buildText(input({ startLine: 42 }))).toBe(
      'src/app.ts:42'
    )
  })

  it('选区跨多行时仍只取起始行，不带结束行——它是「跳到这一行」而不是范围', () => {
    // 与上下文块区分开：path:line 是定位用的单点，若哪天错跟了 endLine，这条红。
    expect(
      actionById('agentmux.copyPathWithLine').buildText(input({ startLine: 5, endLine: 9 }))
    ).toBe('src/app.ts:5')
  })
})

describe('面向 Agent 的上下文块', () => {
  it('一行定位 + 语言围栏包住选中代码，格式写死', () => {
    const text = formatAgentContextBlock(
      input({ startLine: 3, endLine: 6, selectedText: 'const x = 1', fenceLang: 'typescript' })
    )
    expect(text).toBe('src/app.ts:3-6\n```typescript\nconst x = 1\n```\n')
  })

  it('围栏语言跟随文件类型，不写死成某一种', () => {
    const text = formatAgentContextBlock(
      input({ relativePath: 'main.py', startLine: 1, endLine: 2, selectedText: 'pass', fenceLang: 'python' })
    )
    expect(text).toBe('main.py:1-2\n```python\npass\n```\n')
  })

  it('第四个动作 buildText 就是这个上下文块函数（同一出口，不重造格式）', () => {
    const args = input({ startLine: 3, endLine: 6, selectedText: 'const x = 1' })
    expect(actionById('agentmux.copyAgentContext').buildText(args)).toBe(
      formatAgentContextBlock(args)
    )
  })
})

describe('多行选区判据：两侧都守', () => {
  it('结束行大于起始行才算多行', () => {
    expect(hasMultilineSelection(3, 6)).toBe(true)
  })

  it('单行（起止同一行）不算多行——不该出现的那一侧', () => {
    expect(hasMultilineSelection(6, 6)).toBe(false)
  })

  it('无选区（光标一点，起止相等）不算多行', () => {
    expect(hasMultilineSelection(1, 1)).toBe(false)
  })
})

describe('动作清单的门槛：只有上下文块受多行限制', () => {
  it('上下文块动作的 precondition 恰好指向多行上下文键', () => {
    // 定义侧与壳侧（createContextKey）必须同名，否则菜单项会静默地永不出现或永远出现。
    expect(actionById('agentmux.copyAgentContext').precondition).toBe(MULTILINE_SELECTION_CONTEXT_KEY)
  })

  it('三个路径类动作没有 precondition——任何选区状态下都可用', () => {
    for (const id of ['agentmux.copyAbsolutePath', 'agentmux.copyRelativePath', 'agentmux.copyPathWithLine']) {
      expect(actionById(id).precondition).toBeUndefined()
    }
  })

  it('菜单顺序稳定且互不相同', () => {
    expect(EDITOR_COPY_ACTIONS.map((entry) => entry.order)).toEqual([1, 2, 3, 4])
  })
})
