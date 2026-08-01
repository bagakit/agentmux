import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindingById, monacoKeybindingFor } from '../src/renderer/src/lib/shortcut-registry.js'
import { monacoKeybindingConstants } from './helpers/editor-pane-store.js'

// 编辑器的查找/替换/跳行/多光标本来全在场（Monaco 自带，EditorPane 一个都没禁），缺的只是**发现入口**。
// 这条接线要证的就是那道门真的开着。
//
// 为什么不在这里手抄「Cmd+F 查找」之类的行：Monaco 的公开 API 读不到它自己内建命令的键位
// （`IEditorAction` 只给 id/label/metadata），所以任何手抄的键位都无法被验证，改注册表也不会改 Monaco
// 真正 obey 的那个键——那正是 `editor.save` 注释里点名警告的漂移。于是我们只拥有**一个**键，用它打开
// Monaco 自己的命令面板，由面板去声明其余每个命令的真实键位。
//
// `renderToStaticMarkup` 既不跑 effect 也不能派发真实按键，所以判据只能是：挂载时那次注册真的发生了，
// 且跑那个回调真的落到 Monaco 的面板 action 上。两侧各钉一条——只钉注册在场的话，回调指错 action
// （或什么都不做）会静默通过；只钉回调的话，`onMount` 里那一行被删掉后回调压根不存在。
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

const monacoSpy = vi.hoisted(() => ({
  commands: [] as Array<{ keybinding: number; handler: () => void }>,
  /** `getAction` 被问过的每个 id——回调有没有找对那个 action，只能从这里看出来。 */
  actionsRequested: [] as string[],
  paletteRuns: 0,
  /**
   * Monaco 侧到底有没有那个面板 action。默认有；置 false 用来演「Monaco 升级换了 action id」那一天，
   * 此时实现必须响亮地抛，而不是注册一个按下去毫无反应的键。
   */
  paletteAvailable: true
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  // Monaco 常量取自共享 helper（真值，附来源）而不是手抄：缺一个常量就会让某次注册**抛**，
  // 把红打在与被测接线无关的地方。
  const { monacoKeybindingConstants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const editor = {
        addCommand: (keybinding: number, handler: () => void) => {
          monacoSpy.commands.push({ keybinding, handler })
        },
        // 只认 Monaco 真有的那个面板 id，别的 id 一律给 null——这样「回调指错 id」不会碰巧还能跑通，
        // 而是走到实现里那条抛错分支上（实现拒绝注册一个按下去什么都不发生的键）。
        getAction: (id: string) => {
          monacoSpy.actionsRequested.push(id)
          if (id !== 'editor.action.quickCommand' || !monacoSpy.paletteAvailable) return null
          return {
            run: () => {
              monacoSpy.paletteRuns += 1
              return Promise.resolve()
            }
          }
        },
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
    },
    DiffEditor: () => null
  }
})

vi.mock('../src/renderer/src/store.js', async () => {
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

/**
 * 期望的键位由注册表**算**出来，而不是在这里写死一个数字。
 *
 * 这两件事必须是同一个决定：注册表说 `editor.show-commands` 是哪个和弦，EditorPane 就得把那个和弦
 * 交给 Monaco。写死 `2048 | 35` 的话，改注册表（比如把 `e` 换成别的字母）会让这条测试红在一个
 * 与缺陷无关的地方——而真正的缺陷「注册表与 Monaco 各说一个键」反而无人守。
 *
 * 常量同样走共享 helper：这里若自己写一个只含 `KeyE` 的 bag，注册表换字母时 `monacoKeybindingFor`
 * 会在**测试这一侧**抛，红出来的原因看着像「实现坏了」，其实是替身没跟上。替身该供的是真 Monaco
 * 供什么。（这一条是实测的：把注册表改成 `j` 时，自带 bag 的版本三条全红且报 no KeyCode for "j"。）
 */
function expectedKeybinding(): number {
  const binding = bindingById('editor.show-commands')
  if (!binding) throw new Error('editor.show-commands 不在注册表里')
  return monacoKeybindingFor(binding, monacoKeybindingConstants())
}

function mount(): void {
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
}

/** 按一次那个键：跑真的被注册进去的那个回调。 */
function pressShowCommands(): void {
  const command = monacoSpy.commands.find((entry) => entry.keybinding === expectedKeybinding())
  if (!command) throw new Error('editor.show-commands 的和弦从未注册进 Monaco')
  command.handler()
}

afterEach(() => {
  monacoSpy.commands = []
  monacoSpy.actionsRequested = []
  monacoSpy.paletteRuns = 0
  monacoSpy.paletteAvailable = true
  fixture.state.documents = {}
})

describe('编辑器命令面板接线', () => {
  it('挂载时注册的和弦就是注册表说的那个', () => {
    // 承重的是「同一个决定只做一次」：注册表是 SSOT，cheat-sheet 与 Monaco 必须读同一条。
    mount()
    expect(monacoSpy.commands.map((entry) => entry.keybinding)).toContain(expectedKeybinding())
  })

  it('按下去真的打开了 Monaco 自己的命令面板——删掉那行注册或指错 action 这里都会红', () => {
    mount()
    pressShowCommands()
    expect(monacoSpy.actionsRequested).toContain('editor.action.quickCommand')
    expect(monacoSpy.paletteRuns).toBe(1)
  })

  it('面板 action 不在场时响亮地抛，而不是注册一个按下去毫无反应的键', () => {
    // Monaco 升级改了 action id 时的形状。代价是「用户按了唯一那个发现入口，什么都没发生」——而这是
    // 全编辑器唯一一处告诉他查找/替换/多光标存在的地方，所以宁可炸。
    //
    // 这一条独立承重：把实现里那句 throw 删成静默 `return`，上面两条仍全绿（它们都走面板在场那条路），
    // 只有这里会红。
    mount()
    monacoSpy.paletteAvailable = false
    expect(() => pressShowCommands()).toThrow(/editor\.action\.quickCommand/)
    expect(monacoSpy.paletteRuns).toBe(0)
  })
})
