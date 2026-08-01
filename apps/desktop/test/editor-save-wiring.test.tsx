import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 上一层（editor-save-shortcut.test.ts）证明了"按下去该做什么"这个判定是对的。
// 这一层证明的是**它真的被接上了**——判定再正确，没人调用它也等于没做。
// 手法：让 Monaco 的替身在渲染时真的回调 onMount，并交出一个记录 addCommand 的假编辑器，
// 于是 EditorPane 里那行注册代码是真的跑过；删掉它，这里会红。

// store 替身的键集来自 test/helpers/editor-pane-store，不在这里手抄：EditorPane 新读一个 slice 时，
// 手抄的字面量会缺键，而缺键只在**渲染期**炸（`Record<string, unknown>` 这类宽类型让 tsc 全程沉默）。
// 那份 helper 带一条双向比对的检测器（editor-pane-store-fixture.test.ts），键集漏了会在那里点名，
// 而不是在这里变成一堆「Cannot read properties of undefined」。
//
// 为什么不在 vi.hoisted 里取：hoisted 回调提到所有 import 之前执行，那时 helper 还没被加载，
// 而 ESM 下没有 require 可用。vi.mock 的工厂相反是**懒**执行的（模块被解析时才跑），所以键集在
// 那里填。hoisted 里只留这个空壳，好让下面的 mock 工厂和用例共享同一个引用。
const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown> & { saveDocument: ReturnType<typeof vi.fn> }
}))

// 记录 Monaco 侧收到的注册：键位与回调本体都要留下，后者是我们真正要按的那个"键"。
const monacoSpy = vi.hoisted(() => ({
  commands: [] as Array<{ keybinding: number; handler: () => void }>
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  // Monaco 的常量取自共享 helper（真值，附来源）而不是在这里手抄——两个测试文件各抄一份就是漂移。
  const { monacoKeybindingConstants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const editor = {
        addCommand: (keybinding: number, handler: () => void) => {
          monacoSpy.commands.push({ keybinding, handler })
        },
        // EditorPane also registers copy actions on mount; stub the surface they touch so this
        // save-focused test still mounts. (Their own behaviour is covered by editor-copy-wiring.)
        addAction: vi.fn(),
        createContextKey: vi.fn(() => ({ set: vi.fn() })),
        onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        focus: vi.fn()
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
  api: { files: { reveal: vi.fn(async () => {}) } }
}))

import { EditorPane } from '../src/renderer/src/components/EditorPane.js'

const WORKSPACE = 'workspace'
const PATH = 'src/app.ts'
const KEY = `${WORKSPACE}\0${PATH}`
const CMD_S = 2048 | 49

function mount(): void {
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
}

/** 按一次快捷键：跑注册进去的那个真回调。 */
function pressSave(): void {
  const command = monacoSpy.commands.find((entry) => entry.keybinding === CMD_S)
  if (!command) throw new Error('Cmd/Ctrl+S was never registered')
  command.handler()
}

afterEach(() => {
  monacoSpy.commands = []
  fixture.state.documents = {}
  fixture.state.dirtyDocuments = {}
  fixture.state.documentIssues = {}
  fixture.state.savingDocuments = {}
  fixture.state.saveDocument.mockReset()
})

describe('编辑器保存快捷键接线', () => {
  it('挂载时注册的就是 Cmd/Ctrl+S，而不是别的键', () => {
    mount()
    expect(monacoSpy.commands.map((entry) => entry.keybinding)).toContain(CMD_S)
  })

  it('有改动时按下去真的调用了 saveDocument——删掉那行注册这里会红', () => {
    fixture.state.dirtyDocuments[KEY] = true
    mount()
    pressSave()
    expect(fixture.state.saveDocument).toHaveBeenCalledWith('tab', 'region')
  })

  it('没有改动时按下去不写盘', () => {
    mount()
    pressSave()
    expect(fixture.state.saveDocument).not.toHaveBeenCalled()
  })

  it('磁盘已分叉时按下去绝不写盘——快捷键不替用户在 Reload 与 Overwrite 之间做选择', () => {
    // 这是整条通路上唯一不可逆的后果：用户在别处改了这个文件，习惯性按下保存，
    // 就把别人的改动无声冲掉。
    fixture.state.dirtyDocuments[KEY] = true
    fixture.state.documentIssues[KEY] = { kind: 'changed' }
    mount()
    pressSave()
    expect(fixture.state.saveDocument).not.toHaveBeenCalled()
    expect(fixture.state.overwriteDocument).not.toHaveBeenCalled()
  })

  it('读的是按下那一刻的状态，不是挂载那一刻的', () => {
    // Monaco 保留注册时给它的那个回调。若回调闭包捕获了 dirty/issue，它看到的会永远是挂载时的值：
    // 挂载时干净、之后改脏，按键就会什么也不做；更糟的是挂载后才出现的分叉会被无视而落成写盘。
    mount()
    fixture.state.dirtyDocuments[KEY] = true
    pressSave()
    expect(fixture.state.saveDocument).toHaveBeenCalledTimes(1)

    fixture.state.saveDocument.mockReset()
    fixture.state.documentIssues[KEY] = { kind: 'changed' }
    pressSave()
    expect(fixture.state.saveDocument).not.toHaveBeenCalled()
  })
})
