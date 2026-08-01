import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// editor-copy-actions.test.ts 证明了「每个动作产出什么文本、谁在什么条件下出现」这套定义是对的。
// 这一层证明**它们真的被接到了 Monaco 上**——定义再对，没 addAction 上去等于右键没这一项；接上了但
// run 不产出正确文本、或点了不写剪贴板，等于「点了不生效」。两种变异都要咬得住。
//
// 手法同 editor-save-wiring：让 Monaco 替身在渲染时真回调 onMount，交出一个记录 addAction /
// createContextKey / onDidChangeCursorSelection 的假编辑器，于是 EditorPane 里的注册代码真的跑过。

const WORKSPACE = 'workspace'
const PATH = 'src/app.ts'
const ROOT = '/work'
const KEY = `${WORKSPACE}\0${PATH}`

// store 替身的键集与动作 spy 都来自 test/helpers/editor-pane-store，不在这里手抄：EditorPane 新读一个
// slice 时，手抄的字面量会缺键，而缺键只在**渲染期**炸（宽类型让 tsc 全程沉默）。那份 helper 带一条
// 双向比对的检测器（editor-pane-store-fixture.test.ts），键集漏了会在那里点名。
//
// 为什么不在 vi.hoisted 里取：hoisted 回调提到所有 import 之前执行，那时 helper 还没加载，而 ESM 下
// 没有 require。vi.mock 的工厂相反是懒执行的，所以键集在那里填；hoisted 只留空壳共享引用。
const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown> & { reportError: ReturnType<typeof vi.fn> }
}))

// 捕获注册到 Monaco 的动作、上下文键、选区监听。
type CapturedAction = {
  id: string
  label: string
  contextMenuGroupId?: string
  contextMenuOrder?: number
  precondition?: string
  run: (editor: unknown) => void
}
const monacoSpy = vi.hoisted(() => ({
  actions: [] as CapturedAction[],
  contextKeys: [] as Array<{ name: string; set: ReturnType<typeof vi.fn>; value: boolean }>,
  selectionListeners: [] as Array<(event: { selection: { startLineNumber: number; endLineNumber: number } }) => void>,
  // run 时假编辑器要交出的选区 / 模型内容，由每条用例摆布。
  selection: { startLineNumber: 1, endLineNumber: 1 } as { startLineNumber: number; endLineNumber: number } | null,
  position: { lineNumber: 1 } as { lineNumber: number } | null,
  rangeText: ''
}))

// 剪贴板 sink：出口 copyTextToClipboard 在模块顶层 import 了 api，桩它以观测「点了到底写没写、写了什么」。
const clipboard = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => {})
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  // Monaco 的常量取自共享 helper（真值，附来源）而不是在这里手抄：EditorPane 挂载时注册的不止一个
  // 键位，少给一个常量就会让 monacoKeybindingFor 抛，把一个不相关的失败算到复制接线头上。
  const { monacoKeybindingConstants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const editor = {
        addCommand: vi.fn(),
        addAction: (action: CapturedAction) => {
          monacoSpy.actions.push(action)
        },
        createContextKey: (name: string, _default: boolean) => {
          const entry = { name, set: vi.fn((value: boolean) => { entry.value = value }), value: _default }
          monacoSpy.contextKeys.push(entry)
          return entry
        },
        onDidChangeCursorSelection: (cb: (event: { selection: { startLineNumber: number; endLineNumber: number } }) => void) => {
          monacoSpy.selectionListeners.push(cb)
          return { dispose: vi.fn() }
        },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        focus: vi.fn(),
        getSelection: () => monacoSpy.selection,
        getPosition: () => monacoSpy.position,
        getModel: () => ({ getValueInRange: (_range: unknown) => monacoSpy.rangeText })
      }
      onMount?.(editor, monacoKeybindingConstants())
      return null
    }
  }
})

vi.mock('../src/renderer/src/store.js', async () => {
  // 懒执行：到这里 helper 已经可以 import 了。键集与动作 spy 都由它给。
  const { editorPaneStoreState } = await import('./helpers/editor-pane-store.js')
  Object.assign(fixture.state, editorPaneStoreState())
  return {
    useAppStore: Object.assign(
      (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
      { getState: () => fixture.state }
    )
  }
})

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { files: { reveal: vi.fn(async () => {}) }, ui: clipboard }
}))

import { EditorPane } from '../src/renderer/src/components/EditorPane.js'

function mount(): void {
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  fixture.state.config.workspaces = [{ id: WORKSPACE, path: ROOT, hostId: 'local' }]
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
}

function run(id: string): void {
  const action = monacoSpy.actions.find((entry) => entry.id === id)
  if (!action) throw new Error(`action ${id} was never registered`)
  // Monaco hands the editor to run(ed); feed the same spy-backed surface the shell reads from.
  action.run({
    getSelection: () => monacoSpy.selection,
    getPosition: () => monacoSpy.position,
    getModel: () => ({ getValueInRange: (_range: unknown) => monacoSpy.rangeText })
  })
}

/** 最近一次写进剪贴板的文本（未写则抛，让「点了没生效」显形而不是静默过）。 */
function lastCopiedText(): string {
  const calls = clipboard.writeClipboardText.mock.calls
  if (calls.length === 0) throw new Error('clipboard was never written')
  return calls.at(-1)![0]
}

afterEach(() => {
  monacoSpy.actions = []
  monacoSpy.contextKeys = []
  monacoSpy.selectionListeners = []
  monacoSpy.selection = { startLineNumber: 1, endLineNumber: 1 }
  monacoSpy.position = { lineNumber: 1 }
  monacoSpy.rangeText = ''
  fixture.state.documents = {}
  fixture.state.config.workspaces = []
  clipboard.writeClipboardText.mockReset()
  clipboard.writeClipboardText.mockImplementation(async () => {})
  fixture.state.reportError.mockReset()
})

describe('四个复制动作都注册到了 Monaco（删任一 addAction 这里红）', () => {
  const EXPECTED = [
    'agentmux.copyAbsolutePath',
    'agentmux.copyRelativePath',
    'agentmux.copyPathWithLine',
    'agentmux.copyAgentContext'
  ]

  it('挂载后每个动作 id 都出现在注册表里', () => {
    mount()
    const ids = monacoSpy.actions.map((entry) => entry.id)
    for (const id of EXPECTED) expect(ids).toContain(id)
  })

  it('每个动作都进了 agentmux 菜单组，不掺进默认剪切/复制组', () => {
    mount()
    for (const id of EXPECTED) {
      const action = monacoSpy.actions.find((entry) => entry.id === id)!
      expect(action.contextMenuGroupId).toBe('agentmux')
    }
  })
})

describe('点了真的把正确文本写进剪贴板（run 变 no-op / 产错文本这里红）', () => {
  it('复制绝对路径：工作区根 + 相对路径', () => {
    mount()
    run('agentmux.copyAbsolutePath')
    expect(lastCopiedText()).toBe('/work/src/app.ts')
  })

  it('复制相对路径：原样', () => {
    mount()
    run('agentmux.copyRelativePath')
    expect(lastCopiedText()).toBe('src/app.ts')
  })

  it('复制路径:行号取的是选区起始行', () => {
    monacoSpy.selection = { startLineNumber: 42, endLineNumber: 42 }
    mount()
    run('agentmux.copyPathWithLine')
    expect(lastCopiedText()).toBe('src/app.ts:42')
  })

  it('无选区时路径:行号回落到光标行', () => {
    monacoSpy.selection = null
    monacoSpy.position = { lineNumber: 7 }
    mount()
    run('agentmux.copyPathWithLine')
    expect(lastCopiedText()).toBe('src/app.ts:7')
  })

  it('Agent 上下文块：定位 + 语言围栏包住选中文本，语言随文件类型', () => {
    monacoSpy.selection = { startLineNumber: 3, endLineNumber: 6 }
    monacoSpy.rangeText = 'const x = 1'
    mount()
    run('agentmux.copyAgentContext')
    expect(lastCopiedText()).toBe('src/app.ts:3-6\n```typescript\nconst x = 1\n```\n')
  })

  it('复制失败不会静默：走的是共用出口，错误进 reportError', async () => {
    const boom = new Error('denied')
    clipboard.writeClipboardText.mockRejectedValueOnce(boom)
    mount()
    run('agentmux.copyRelativePath')
    // run 内部 void 了出口的 promise；等一个微任务让 catch 跑完。
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.state.reportError).toHaveBeenCalledWith(boom)
  })
})

describe('Agent 上下文块的显隐两侧都守', () => {
  it('该出现时：多行选区把上下文键置 true', () => {
    mount()
    const key = monacoSpy.contextKeys.find((entry) => entry.name === 'agentmuxEditorHasMultilineSelection')
    expect(key, '多行上下文键从未被创建').toBeTruthy()
    // 触发一次选区变化：结束行 > 起始行 = 多行。
    for (const cb of monacoSpy.selectionListeners) {
      cb({ selection: { startLineNumber: 2, endLineNumber: 5 } })
    }
    expect(key!.set).toHaveBeenLastCalledWith(true)
    expect(key!.value).toBe(true)
  })

  it('不该出现时：单行选区把上下文键置 false', () => {
    // 只守「多行→true」不够——若判据取反或恒真，这条会红。两侧都钉。
    mount()
    const key = monacoSpy.contextKeys.find((entry) => entry.name === 'agentmuxEditorHasMultilineSelection')!
    for (const cb of monacoSpy.selectionListeners) {
      cb({ selection: { startLineNumber: 4, endLineNumber: 4 } })
    }
    expect(key.set).toHaveBeenLastCalledWith(false)
    expect(key.value).toBe(false)
  })

  it('上下文块动作带着指向那个键的 precondition——键与 precondition 同名，菜单才真受控', () => {
    mount()
    const action = monacoSpy.actions.find((entry) => entry.id === 'agentmux.copyAgentContext')!
    expect(action.precondition).toBe('agentmuxEditorHasMultilineSelection')
    // 三个路径动作无 precondition：任何时候都在。
    for (const id of ['agentmux.copyAbsolutePath', 'agentmux.copyRelativePath', 'agentmux.copyPathWithLine']) {
      expect(monacoSpy.actions.find((entry) => entry.id === id)!.precondition).toBeUndefined()
    }
  })
})
