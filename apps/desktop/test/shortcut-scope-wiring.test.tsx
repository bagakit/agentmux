import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import {
  SHORTCUT_BINDINGS,
  SHORTCUT_SCOPES,
  bindingById,
  monacoKeybindingFor
} from '../src/renderer/src/lib/shortcut-registry.js'
import { SHORTCUT_WIRING, wiringScopeDrift } from '../src/renderer/src/lib/shortcut-wiring.js'
import { windowShortcutHandlers, type WorkbenchShortcutStore } from '../src/renderer/src/lib/workbench-shortcuts.js'
import { monacoKeybindingConstants } from './helpers/editor-pane-store.js'

// 跨 scope 的接线元守卫：**每个** scope 的壳都必须真的把匹配出的 id 变成动作。
//
// 为什么要有这一层，而四条既有的逐 scope 守卫不够：它们四条各自发明了一套判法
// （window 遍历 handler map、terminal 读源码要 `=== 'id'`、editor 把和弦喂给 monacoKeybindingFor、
// launcher 用 AST 判壳里恰好三句），于是加第五个 scope 时会在三处响亮失败——
// `groupIdForBinding` 的 tsc `never` 穷尽、cheat-sheet 的逐 scope 分组守卫、
// shortcut-registry.test.ts 那份冻结 id 集——但**「这个 scope 的壳有没有接住它」一条都不会红**。
// 新 scope 的绑定可以带着正确的和弦、正确的 cheat-sheet 分组发货，用户按下去什么都不发生。
//
// 元守卫的形状：遍历 {@link SHORTCUT_SCOPES}，按 {@link SHORTCUT_WIRING} 里声明的 kind 分派到对应
// 的质询方式上。判据**不是**「scope 名字在某个源文件里出现过」——那种判法对「声明了一条绑定但没接线」
// 完全失明，正是它要防的那个靶子。每种 kind 都要能指出**具体哪条绑定 id** 没被接住。
//
// 顺带补上的真洞：editor scope 此前只有三个各钉一个 id 的测试
// （editor-save-wiring / editor-wordwrap-wiring / editor-command-palette-wiring），
// 没有任何遍历。加第四条 editor 绑定时，cheat-sheet 会照样把它显出来、tsc 沉默、全套测试全绿，
// 而 EditorPane 的 onMount 里少一次 addCommand——那个键按下去什么都不发生。
// 下面 `monaco-command` 那条把 SHIPPING 的 editor 绑定整份跑过挂载，是这个洞的补法。

// --- Monaco / store 替身：与 editor-command-palette-wiring 同一套手法（那里有完整理由说明）。 -----
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

const monacoSpy = vi.hoisted(() => ({
  /** 挂载时真的注册进 Monaco 的每个和弦。editor scope 的判据全落在这份记录上。 */
  commands: [] as number[]
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  const { monacoKeybindingConstants: constants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const editor = {
        addCommand: (keybinding: number) => {
          monacoSpy.commands.push(keybinding)
        },
        // 面板 action 必须在场，否则实现在注册阶段之后的回调里抛——那与本条要判的事无关。
        getAction: (id: string) =>
          id === 'editor.action.quickCommand' ? { run: () => Promise.resolve() } : null,
        addAction: vi.fn(),
        createContextKey: vi.fn(() => ({ set: vi.fn() })),
        onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        focus: vi.fn()
      }
      onMount?.(editor, constants())
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

/** 把 EditorPane 挂一次，返回它注册进 Monaco 的和弦集合。 */
function chordsRegisteredOnMount(): Set<number> {
  monacoSpy.commands = []
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
  return new Set(monacoSpy.commands)
}

/** 极简 store 替身：只要 windowShortcutHandlers 能构造出 map，本条不关心转发落到哪。 */
function stubStore(): WorkbenchShortcutStore {
  const noop = (): void => {}
  return {
    activeWorkspaceId: 'ws',
    layouts: {},
    tabs: {},
    activateTab: noop,
    closeRegion: noop,
    splitRegion: noop,
    setActiveRegion: noop
  } as unknown as WorkbenchShortcutStore
}

/** 读壳的源码并剥掉注释——注释里写的 id 不算接线。 */
function shellCode(relative: string): string {
  const text = readFileSync(new URL(`../src/renderer/src/${relative}`, import.meta.url), 'utf8')
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

afterEach(() => {
  monacoSpy.commands = []
  fixture.state.documents = {}
})

describe('每个 scope 的壳都真的把匹配出的 id 变成动作', () => {
  it('接线表与 scope 清单逐键对齐（多一行少一行都红）', () => {
    // `Record<ShortcutScope, …>` 在 tsc 侧挡住「少一行」，这条守住「多一行」：一个已删掉的 scope
    // 留在表里，会让下面的遍历去检查一个不存在的 scope——那一轮抽到零条绑定，于是恒绿。
    const drift = wiringScopeDrift()
    expect(drift, `接线表与 SHORTCUT_SCOPES 不一致：${JSON.stringify(drift)}`).toEqual({
      missing: [],
      extra: []
    })
  })

  it('每个 scope 至少有一条绑定，且每条绑定的 scope 都在表里', () => {
    // 遍历型判据的自检。任一 scope 抽到零条绑定时，它那一轮的 for 循环体一次都不执行——
    // 断言全部退化成恒真。宁可在这里响亮地红，也不要让某个 scope 静默地不被检查。
    for (const scope of SHORTCUT_SCOPES) {
      const inScope = SHORTCUT_BINDINGS.filter((b) => b.scope === scope)
      expect(inScope.length, `scope ${scope} 一条绑定都没有——它那一轮检查会退化成恒真`).toBeGreaterThan(0)
    }
    // 反向：注册表里没有 scope 落在表外（tsc 已挡住 ShortcutScope 之外的值，这条钉住运行期一致）。
    const covered = new Set(Object.keys(SHORTCUT_WIRING))
    for (const binding of SHORTCUT_BINDINGS) {
      expect(covered.has(binding.scope), `绑定 ${binding.id} 的 scope ${binding.scope} 不在接线表里`).toBe(true)
    }
  })

  it('三种 kind 都真的被用到——没有哪条检查是死代码', () => {
    // 如果某种 kind 在表里一次都没出现，下面 switch 里那个分支就是死代码，它守的那类壳
    // 实际上无人守而这个文件照旧全绿。改壳的机制时（比如 terminal 从读源码换成可运行期质询）
    // 必须同时改这里，那正是我们想要的摩擦。
    const kinds = new Set(Object.values(SHORTCUT_WIRING).map((entry) => entry.kind))
    expect([...kinds].sort()).toEqual(['handler-map', 'id-comparison', 'monaco-command'])
  })

  for (const scope of SHORTCUT_SCOPES) {
    const wiring = SHORTCUT_WIRING[scope]
    const ids = SHORTCUT_BINDINGS.filter((b) => b.scope === scope).map((b) => b.id)

    it(`${scope}（${wiring.kind}）：${ids.length} 条绑定全部被壳接住`, () => {
      // 每条 kind 的质询方式都指向「那条 id 到底有没有执行路径」，而不是「名字出现过」。
      if (wiring.kind === 'handler-map') {
        const handlers = windowShortcutHandlers(stubStore(), {
          toggleQuickSwitch: () => {},
          toggleShortcutsHelp: () => {}
        })
        for (const id of ids) {
          expect(typeof handlers[id], `${scope} 绑定 ${id} 在 handler map 里没有 handler`).toBe('function')
        }
        return
      }

      if (wiring.kind === 'id-comparison') {
        const code = shellCode(wiring.shell)
        for (const id of ids) {
          // 锚在带比较运算符的形状上：注册表 import 进来的裸字符串不满足它。两种极性都算接住
          // （terminal 用 `=== 'id'` 分派，launcher 用 `!== 'id'` 早退）。
          const matched = code.includes(`=== '${id}'`) || code.includes(`!== '${id}'`)
          expect(matched, `${wiring.shell} 没有对 ${scope} 绑定 ${id} 做 id 比较`).toBe(true)
        }
        return
      }

      // monaco-command：把 SHIPPING 的绑定整份跑过一次真挂载，问「这个和弦注册进去了吗」。
      // 这是 editor scope 此前完全缺失的那一层——三个既有测试各钉一个 id，加第四条不会红。
      const registered = chordsRegisteredOnMount()
      expect(registered.size, `${wiring.shell} 挂载时一个命令都没注册——替身或挂载路径变了`).toBeGreaterThan(0)
      for (const id of ids) {
        const binding = bindingById(id)
        expect(binding, `${id} 不在注册表里`).not.toBeNull()
        const chord = monacoKeybindingFor(binding!, monacoKeybindingConstants())
        expect(
          registered.has(chord),
          `${wiring.shell} 挂载时没有为 ${scope} 绑定 ${id} 注册命令——那个键按下去什么都不会发生`
        ).toBe(true)
      }
    })
  }

  it('壳的路径都真的存在——写错路径必须响亮失败而不是静默跳过', () => {
    // 这张表的 `shell` 是手写字符串。写错一个字母时，读源码那两条会 ENOENT 炸掉（这是刻意的），
    // 但 handler-map 与 monaco-command 两条根本不读 shell 字段，于是它们的路径写错完全无症状——
    // 读表的人会被一个指向不存在文件的注释误导。这条无差别地钉住四行。
    for (const scope of SHORTCUT_SCOPES) {
      const relative = SHORTCUT_WIRING[scope].shell
      expect(
        () => readFileSync(new URL(`../src/renderer/src/${relative}`, import.meta.url), 'utf8'),
        `scope ${scope} 的壳路径 ${relative} 不存在`
      ).not.toThrow()
    }
  })

  it('id-comparison 那两个壳的比较对象是 matchShortcut 的返回值，不是别处的字符串', () => {
    // 上面那条 `=== 'id'` 是文本判据，它认不出「比较的左边不是匹配出的 id」这种形状——比如把
    // `shortcutId === 'terminal.search'` 换成 `event.key === 'terminal.search'`，文本照旧命中而
    // 分支永不成立。判据因此要落在 AST 上：那个 scope 的 shell 里必须存在一次
    // `matchShortcut(…, { scope: '<scope>' })` 调用，且它的返回值被赋给某个名字，
    // 而上面那些比较的左边正是这个名字（或直接就是那次调用）。
    for (const scope of SHORTCUT_SCOPES) {
      const wiring = SHORTCUT_WIRING[scope]
      if (wiring.kind !== 'id-comparison') continue
      const text = readFileSync(new URL(`../src/renderer/src/${wiring.shell}`, import.meta.url), 'utf8')
      const source = ts.createSourceFile(wiring.shell, text, ts.ScriptTarget.Latest, true)

      /** 这个 scope 的 matchShortcut 调用被存进了哪些名字（以及是否直接内联比较）。 */
      const carriers = new Set<string>()
      let inlineCompared = false

      const isScopedMatch = (node: ts.Node): boolean => {
        if (!ts.isCallExpression(node)) return false
        const callee = node.expression
        const name = ts.isIdentifier(callee) ? callee.text : null
        if (name !== 'matchShortcut') return false
        // 最后一个实参里必须写着这个 scope。取字面量而不是变量：scope 由调用点直接决定。
        return node.arguments.some((arg) => {
          if (!ts.isObjectLiteralExpression(arg)) return false
          return arg.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText() === 'scope' &&
              ts.isStringLiteral(prop.initializer) &&
              prop.initializer.text === scope
          )
        })
      }

      const walk = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer && isScopedMatch(node.initializer)) {
          carriers.add(node.name.getText())
        }
        if (
          ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
          isScopedMatch(node.left)
        ) {
          inlineCompared = true
        }
        ts.forEachChild(node, walk)
      }
      walk(source)

      expect(
        carriers.size > 0 || inlineCompared,
        `${wiring.shell} 里没有 matchShortcut(scope: '${scope}') 的返回值被比较——那些 id 比较判的是别的东西`
      ).toBe(true)

      // 每条绑定的比较左边必须是那些载体之一（或就是内联的那次调用）。
      const compared = new Set<string>()
      const collect = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
          ts.isStringLiteral(node.right)
        ) {
          const left = node.left
          const leftName = ts.isIdentifier(left) ? left.text : null
          if ((leftName && carriers.has(leftName)) || isScopedMatch(left)) {
            compared.add(node.right.text)
          }
        }
        ts.forEachChild(node, collect)
      }
      collect(source)

      for (const id of SHORTCUT_BINDINGS.filter((b) => b.scope === scope).map((b) => b.id)) {
        expect(
          compared.has(id),
          `${wiring.shell} 里 ${id} 的比较左边不是 matchShortcut(scope: '${scope}') 的结果`
        ).toBe(true)
      }
    }
  })
})
