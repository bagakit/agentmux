import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { SHORTCUT_BINDINGS, SHORTCUT_SCOPES, bindingById, monacoKeybindingFor } from '../src/renderer/src/lib/shortcut-registry.js'
import { windowShortcutHandlers, type WorkbenchShortcutStore } from '../src/renderer/src/lib/workbench-shortcuts.js'
import { launcherKeydownLaunches } from '../src/renderer/src/lib/launcher-submit.js'
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
// 元守卫的形状：遍历 {@link SHORTCUT_SCOPES}，每个 scope 在下面的 switch 里必须有一条质询分支，
// **没有就抛**——这就是「加 scope 时逼作者回答壳是谁」的那道摩擦，落点在测试里而不是在一张
// 生产侧的配置表里。此前这里有一个 `SHORTCUT_WIRING: Record<ShortcutScope, …>` 表想做同一件事，
// 已删除，理由记在下面 scopeWithoutInterrogation 那条断言上。
//
// 判据**不是**「scope 名字在某个源文件里出现过」——那种判法对「声明了一条绑定但没接线」
// 完全失明，正是它要防的那个靶子。每种质询都要能指出**具体哪条绑定 id** 没被接住。
//
// 顺带补上的真洞：editor scope 此前只有三个各钉一个 id 的测试
// （editor-save-wiring / editor-wordwrap-wiring / editor-command-palette-wiring），
// 没有任何遍历。加第四条 editor 绑定时，cheat-sheet 会照样把它显出来、tsc 沉默、全套测试全绿，
// 而 EditorPane 的 onMount 里少一次 addCommand——那个键按下去什么都不发生。
// 下面 editor 那条把 SHIPPING 的 editor 绑定整份跑过挂载，是这个洞的补法。

// --- Monaco / store 替身：与 editor-command-palette-wiring 同一套手法（那里有完整理由说明）。 -----
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

const monacoSpy = vi.hoisted(() => ({
  /**
   * 挂载时真的注册进 Monaco 的每个和弦，**连同它注册的那个 handler**。
   *
   * 早先这里只记和弦号，把 handler 丢掉。那让 editor 那条质询退化成「注册在场」：注册一个
   * handler 体是空的命令，键按下去什么都不发生，而整族 120 条全绿——实测过一次（加第四条
   * editor 绑定 + 空 handler 体 + 同步冻结 id 集，全绿存活）。所以 handler 必须留下来被调用。
   */
  commands: [] as Array<{ keybinding: number; handler: () => void }>,
  /**
   * handler 在运行期真的碰过多少次外界。空 handler 恒为 0，这就是判据。
   *
   * 为什么按「碰了几次」而不是断言某个具体的 store spy：三条 editor 绑定的出口互不相同
   * （save 读 getState 再调 saveDocument、换行开关读 getState 再 toggle、命令面板走
   * editor.getAction().run()），硬钉某一个 spy 只能覆盖其中一条，加第四条绑定又会退化成
   * 「新绑定无人守」——那正是这条要防的形状。计数对三条都成立，且对未来的第四条默认成立。
   */
  touches: 0
}))

vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', async () => {
  const { monacoKeybindingConstants: constants } = await import('./helpers/editor-pane-store.js')
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      const editor = {
        addCommand: (keybinding: number, handler: () => void) => {
          monacoSpy.commands.push({ keybinding, handler })
        },
        // 面板 action 必须在场，否则实现在注册阶段之后的回调里抛——那与本条要判的事无关。
        // 取用本身计入 touches：命令面板那条绑定的**唯一**可观测出口就是这次取用。
        getAction: (id: string) => {
          monacoSpy.touches += 1
          return id === 'editor.action.quickCommand' ? { run: () => Promise.resolve() } : null
        },
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
      {
        // getState 也计入 touches。它在挂载期同样会被调用，所以计数只有在**调用 handler 之前
        // 归零**的窗口里才有意义——见 handlerTouchesStore。
        getState: () => {
          monacoSpy.touches += 1
          return fixture.state
        }
      }
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

/** 把 EditorPane 挂一次，返回它注册进 Monaco 的每个命令（和弦 + handler）。 */
function commandsRegisteredOnMount(): Array<{ keybinding: number; handler: () => void }> {
  monacoSpy.commands = []
  fixture.state.documents = { [KEY]: { path: PATH, content: 'hello', revision: 'r1' } }
  renderToStaticMarkup(
    createElement(EditorPane, {
      tabId: 'tab',
      surface: { regionId: 'region', kind: 'file' as const, workspaceId: WORKSPACE, path: PATH }
    })
  )
  return monacoSpy.commands
}

/**
 * 调一次那个 handler，回答「它有没有碰过外界」。
 *
 * 计数在调用前归零，所以挂载期的读取不算进来——判据落在**这次按键**上。
 * 用它而不是断言某个具体 store 动作：见 monacoSpy.touches 的说明。
 */
function handlerTouchesStore(handler: () => void): boolean {
  monacoSpy.touches = 0
  handler()
  return monacoSpy.touches > 0
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

/**
 * 每个 scope 一条质询：给定这个 scope 的全部绑定 id，证明壳真的会把它们变成动作。
 *
 * 质询方式按「这个壳能被问到什么程度」选，而不是按一个声明出来的 kind 分类。三种深度，
 * 从强到弱，新 scope 应尽量往上靠：
 * 1. **直接调那个决策函数**（launcher）——最强，判的就是运行期行为本身。
 * 2. **挂载后调它注册的 handler**（editor）——次之，注册在场与「按下去有后果」都可证，
 *    但「后果对不对」（存的是这个文件吗、翻的是这个开关吗）由三个逐 id 的 wiring 测试各自钉。
 * 3. **读源码断言比较在场**（window 的 handler map 除外，terminal 只能到这一层）——最弱，
 *    「比较在场」不等于「后果发生」：terminal 的分支体清空后这一层照旧全绿，那是 #360 的靶子。
 */
const SCOPE_INTERROGATIONS = new Map<string, (ids: readonly string[]) => void>([
  [
    'window',
    (ids) => {
      // 壳查一张 `Record<id, () => boolean>`，所以直接向那份 map 要 handler。
      const handlers = windowShortcutHandlers(stubStore(), {
        toggleQuickSwitch: () => {},
        toggleShortcutsHelp: () => {}
      })
      for (const id of ids) {
        expect(typeof handlers[id], `window 绑定 ${id} 在 handler map 里没有 handler`).toBe('function')
      }
    }
  ],
  [
    'terminal',
    (ids) => {
      // TerminalView 的 attachCustomKeyEventHandler 在 effect 里，renderToStaticMarkup 不跑 effect
      // 也发不出键，所以只能读源码。判据锚在带比较运算符的形状上：注册表 import 进来的裸字符串
      // 不满足它。**这一层的已知上限**：分支体清空后照旧全绿（#360 实测），补法是把壳抽成
      // terminalShortcutHandlers 工厂，那时这条就该换成 window 那样的直接质询。
      const code = shellCode('components/TerminalView.tsx')
      for (const id of ids) {
        expect(code.includes(`=== '${id}'`), `TerminalView.tsx 没有对 terminal 绑定 ${id} 做 id 比较`).toBe(true)
      }
    }
  ],
  [
    'editor',
    (ids) => {
      // 把 SHIPPING 的绑定整份跑过一次真挂载，问两件事：这个和弦注册进去了吗，**按下去有后果吗**。
      // 这是 editor scope 此前完全缺失的那一层——三个既有测试各钉一个 id，加第四条不会红。
      //
      // 「有后果吗」是后补的一层，理由是实测：只判「注册在场」时，注册一个 handler 体为空的
      // 第四条绑定（并同步冻结 id 集）在全族 120 条下存活——键按下去什么都不发生，无人守。
      const commands = commandsRegisteredOnMount()
      expect(commands.length, 'EditorPane 挂载时一个命令都没注册——替身或挂载路径变了').toBeGreaterThan(0)
      const byChord = new Map(commands.map((c) => [c.keybinding, c.handler]))
      for (const id of ids) {
        const binding = bindingById(id)
        expect(binding, `${id} 不在注册表里`).not.toBeNull()
        const chord = monacoKeybindingFor(binding!, monacoKeybindingConstants())
        const handler = byChord.get(chord)
        expect(
          handler,
          `EditorPane 挂载时没有为 editor 绑定 ${id} 注册命令——那个键按下去什么都不会发生`
        ).toBeTypeOf('function')
        expect(
          handlerTouchesStore(handler!),
          `editor 绑定 ${id} 注册了但按下去不碰 store 也不碰 editor——handler 体是空的，键是死的`
        ).toBe(true)
      }
    }
  ],
  [
    'launcher',
    (ids) => {
      // launcher 的判定是一个导出的纯函数，够得着直接调——所以就直接调，不读源码。
      // 之前这里走的是「源码里有 `!== 'id'`」的文本判据，那是白白放弃了唯一能真跑的那个 scope。
      expect(ids, 'launcher 目前只有一条绑定；多出来的没有被这条质询覆盖').toEqual(['launcher.submit'])
      const ready = { hasWorkspace: true, busy: false, installedExecutorCount: 1 }
      const chord = { key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
      // 正向：就绪时那个和弦真的会启动。
      expect(launcherKeydownLaunches(chord, true, ready), 'Cmd+Enter 在就绪状态下没有启动').toBe(true)
      // 反向两条，各钉一个必要条件——缺了任一条，「恒 true」都能骗过上面那条。
      expect(
        launcherKeydownLaunches({ ...chord, metaKey: false }, true, ready),
        '裸 Enter 也启动了——那条和弦判定没在起作用'
      ).toBe(false)
      expect(
        launcherKeydownLaunches(chord, true, { ...ready, installedExecutorCount: 0 }),
        '一个 executor 都没装还启动了——就绪判定没在起作用'
      ).toBe(false)
    }
  ]
])

afterEach(() => {
  monacoSpy.commands = []
  fixture.state.documents = {}
})

describe('每个 scope 的壳都真的把匹配出的 id 变成动作', () => {
  it('每个 scope 至少有一条绑定，且每条绑定的 scope 都在清单里', () => {
    // 遍历型判据的自检。任一 scope 抽到零条绑定时，它那一轮的 for 循环体一次都不执行——
    // 断言全部退化成恒真。宁可在这里响亮地红，也不要让某个 scope 静默地不被检查。
    for (const scope of SHORTCUT_SCOPES) {
      const inScope = SHORTCUT_BINDINGS.filter((b) => b.scope === scope)
      expect(inScope.length, `scope ${scope} 一条绑定都没有——它那一轮检查会退化成恒真`).toBeGreaterThan(0)
    }
    // 反向：注册表里没有 scope 落在清单外（tsc 已挡住 ShortcutScope 之外的值，这条钉住运行期一致）。
    const declared = new Set<string>(SHORTCUT_SCOPES)
    for (const binding of SHORTCUT_BINDINGS) {
      expect(declared.has(binding.scope), `绑定 ${binding.id} 的 scope ${binding.scope} 不在 SHORTCUT_SCOPES 里`).toBe(true)
    }
  })

  it('每个 scope 都有一条质询分支——加 scope 时这里必须响亮失败而不是静默跳过', () => {
    // 这是「加第五个 scope 时逼作者回答壳是谁」的那道摩擦。
    //
    // 此前这个位置是一张生产侧的表 `SHORTCUT_WIRING: Record<ShortcutScope, {kind, shell}>`，指望
    // tsc 在缺键时先报错。删掉了，三个理由，每个都实测过：
    // 1. 那道摩擦**已经有人守**：shortcut-cheat-sheet.ts 的 groupIdForBinding 里有
    //    `const unreachable: never = binding.scope`，加 scope 时它先炸。表的缺键压力从一开始
    //    就是第二层预算。
    // 2. 配套的运行期 `wiringScopeDrift()` 声称补上「多一行」（tsc 只挡少一行），那句话是假的：
    //    `Record<Union, T>` 直接赋对象字面量时，多一个键报 TS2353，少一个键报 TS2741，两侧都挡。
    //    实测过一次 20 行探针。所以那个函数与它那条测试是恒假阴性。
    // 3. 表里的 `kind` 是「测试用哪种方式质询」，不是架构的一个轴。三个 kind 里两个的实现根本
    //    不读表里的 `shell` 字段（handler-map 硬写 windowShortcutHandlers，monaco-command 硬写
    //    chordsRegisteredOnMount），于是那个字段指向一个错的但存在的文件时整套测试照旧全绿。
    //    把「怎么测」编码成生产类型，还会激励壳往最难测的形状长——三个 kind 里唯一可复用的那个
    //    是「读源码文本」。
    //
    // 换成这条：判据落在「下面的 switch 认不认这个 scope」上，摩擦保留，生产侧不留残渣。
    const interrogated = new Set(SCOPE_INTERROGATIONS.keys())
    const missing = SHORTCUT_SCOPES.filter((scope) => !interrogated.has(scope))
    expect(missing, `这些 scope 没有质询分支，它们的壳有没有接住绑定完全无人守：${missing.join(', ')}`).toEqual([])
    // 反向：没有为已删除的 scope 留下死分支。留着会让读表的人以为某个 scope 被守着。
    const stale = [...interrogated].filter((scope) => !SHORTCUT_SCOPES.includes(scope as never))
    expect(stale, `这些质询分支对应的 scope 已不存在：${stale.join(', ')}`).toEqual([])
  })

  for (const scope of SHORTCUT_SCOPES) {
    const ids = SHORTCUT_BINDINGS.filter((b) => b.scope === scope).map((b) => b.id)

    it(`${scope}：${ids.length} 条绑定全部被壳接住`, () => {
      const interrogate = SCOPE_INTERROGATIONS.get(scope)
      // 上面那条已经整体判过一次；这里再取一次是为了让**这一轮**在缺失时也响亮失败，
      // 而不是 `undefined?.()` 静默什么都不做。
      if (!interrogate) throw new Error(`scope ${scope} 没有质询分支——上面那条断言应该已经红了`)
      interrogate(ids)
    })
  }

  it('TerminalView 里那些 id 比较的左边是 matchShortcut 的返回值，不是别处的字符串', () => {
    // 上面 terminal 那条走的是文本判据（`=== 'id'` 在场），它认不出「比较的左边不是匹配出的 id」
    // 这种形状——把 `shortcutId === 'terminal.search'` 换成 `event.key === 'terminal.search'`，
    // 文本照旧命中而分支永不成立。判据因此落在 AST 上：壳里必须存在一次
    // `matchShortcut(…, { scope: 'terminal' })` 调用，且它的返回值被赋给某个名字，
    // 而那些比较的左边正是这个名字（或直接就是那次调用）。
    //
    // 只对 terminal 做：这是唯一还靠读源码的 scope。launcher 此前也走这条，现在改成直接调
    // launcherKeydownLaunches，那更强，不需要这层代偿。#360 把 terminal 也抽成工厂之后，
    // 这条连同上面那条文本判据都该一起删掉。
    const relative = 'components/TerminalView.tsx'
    const text = readFileSync(new URL(`../src/renderer/src/${relative}`, import.meta.url), 'utf8')
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true)

    const isScopedMatch = (node: ts.Node): boolean => {
      if (!ts.isCallExpression(node)) return false
      const callee = node.expression
      if (!ts.isIdentifier(callee) || callee.text !== 'matchShortcut') return false
      // 实参里必须写着字面量 'terminal'。取字面量而不是变量：scope 由调用点直接决定。
      return node.arguments.some(
        (arg) =>
          ts.isObjectLiteralExpression(arg) &&
          arg.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText() === 'scope' &&
              ts.isStringLiteral(prop.initializer) &&
              prop.initializer.text === 'terminal'
          )
      )
    }

    /** 那次调用的返回值被存进了哪些名字（以及是否直接内联比较）。 */
    const carriers = new Set<string>()
    let inlineCompared = false
    /** 左边是载体、右边是字面量的那些比较，右边的取值。 */
    const compared = new Set<string>()

    const isIdComparison = (node: ts.Node): node is ts.BinaryExpression =>
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)

    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && isScopedMatch(node.initializer)) {
        carriers.add(node.name.getText())
      }
      if (isIdComparison(node) && isScopedMatch(node.left)) inlineCompared = true
      ts.forEachChild(node, walk)
    }
    walk(source)

    expect(
      carriers.size > 0 || inlineCompared,
      `${relative} 里没有 matchShortcut(scope: 'terminal') 的返回值被比较——那些 id 比较判的是别的东西`
    ).toBe(true)

    // 第二遍：载体集合此时已完整，逐个收集比较的右值。
    const collect = (node: ts.Node): void => {
      if (isIdComparison(node) && ts.isStringLiteral(node.right)) {
        const leftName = ts.isIdentifier(node.left) ? node.left.text : null
        if ((leftName && carriers.has(leftName)) || isScopedMatch(node.left)) compared.add(node.right.text)
      }
      ts.forEachChild(node, collect)
    }
    collect(source)

    const terminalIds = SHORTCUT_BINDINGS.filter((b) => b.scope === 'terminal').map((b) => b.id)
    expect(terminalIds.length, 'terminal 一条绑定都没有——这条会退化成恒真').toBeGreaterThan(0)
    for (const id of terminalIds) {
      expect(
        compared.has(id),
        `${relative} 里 ${id} 的比较左边不是 matchShortcut(scope: 'terminal') 的结果`
      ).toBe(true)
    }
  })
})
