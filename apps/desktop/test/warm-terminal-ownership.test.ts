import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// store.ts 经 api.ts 读一个 build-time define；在 vitest 下没有 electron，所以按邻居测试的做法
// 先把它钉成 web preview（mock api），否则 import 期就 ReferenceError。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { warmLauncherId, warmTerminalPreview } from '../src/renderer/src/lib/warm-terminal-preview.js'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 热终端槽的归属（#308）。
//
// 槽是**全局单个**而 launcher 是**每个挂载点一个**。分屏能在同一个 Tab 里开出好几个，空分组占位又能
// 在每个 group 里各有一个，它们的 warmKey 逐字相同（同 host 同 cwd），所以「这个槽是不是我的」只判
// key 是判不出来的。
//
// 只判 key 时每个 launcher 都会把一个 TerminalView 挂到同一个 run 上，而 attach 那一侧**不报错**：
// 同一个 session 快照算出同一个 control identity，第二次 attach 走 readRunReplay 而不是「owner 已存在」
// 那条抛出。所以整条路径零信号——但两个 view 各有自己的 FitAddon 与 ResizeObserver，尺寸不同就对着
// 同一个 PTY 轮流 resize，网格来回跳，两边的 xterm 都在错的行列上重排。
//
// 归属键必须**永远在场**。此前取的是 regionId，而空分组占位没有 region——「没有 regionId 就不显示
// 预览」把新建 workspace 的第一眼（最主要那条路径）永久降级成冷卡片，new-tab-resource-contract 当场
// 打红。现在由 warmLauncherId 从 props 算：有 region 用 region，没有就退到所属 group。
//
// （useId() 在本仓不可用：renderToStaticMarkup 不跑 effect，SSR 下没有任何 launcher 拿到归属，邻居
// 那条 live-preview 断言会变成不可达的死覆盖——净损失。所以键必须能从 props 推出来。）
//
// 这个文件守三层，缺一层就有一族回归无人守：
//   1. 纯函数层：warmTerminalPreview 的取值（归属命中 / 不命中 / 预热中 / 换 key / 无 workspace）
//   2. store 层：同 key 再请求要**转移归属**而不是 no-op
//   3. 接线层：组件里那三个取值真的来自同一次判定，且预热 effect 的依赖与归属无关
// ---------------------------------------------------------------------------

function terminalSession(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    executorId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', terminalSessionId: id }
  }
}

const KEY = warmTerminalKey('local', '/repo')

describe('warmTerminalPreview：预览只属于槽的 owner', () => {
  const session = terminalSession('warm-1')

  it('归属命中时给出 session', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
        warmKey: KEY,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session, pending: false, slotHeld: true })
  })

  it('同 key 但归属是别人时不给 session —— 这就是两个 view 抢一个 PTY 的那一刻', () => {
    // 分屏里的同胞 launcher：warmKey 逐字相同，只判 key 的旧写法在这里也会返回 session，
    // 于是两个 TerminalView 挂到同一个 run 上，各自 fit 同一个 PTY。
    const preview = warmTerminalPreview({
      warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
      warmKey: KEY,
      launcherId: 'launcher-b'
    })
    expect(preview.session, '同胞 launcher 也拿到了 session——两个 view 会抢同一个 PTY').toBeNull()
    // 但它不该显示「正在预热」：shell 已经起好了，只是不归它。
    expect(preview.pending).toBe(false)
    // 槽仍然在场，只是不归它——预热 effect 不该因此再起一个 PTY。
    expect(preview.slotHeld, '同胞把「槽在不在」读成了假，会重复预热').toBe(true)
  })

  it('槽是本 workspace 的但 shell 还没起好 → pending，不论归属给谁', () => {
    // 点下去 promote 会等 ready，所以显示「正在预热」而不是冷卡片。归属在这一刻还没意义。
    for (const owner of ['launcher-a', 'launcher-b']) {
      expect(
        warmTerminalPreview({
          warmTerminal: { key: KEY, ownerLauncherId: owner, session: null },
          warmKey: KEY,
          launcherId: 'launcher-b'
        }),
        `owner=${owner}`
      ).toEqual({ session: null, pending: true, slotHeld: true })
    }
  })

  it('key 不同（另一个 host 或另一个 cwd）时三个取值都是空', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: warmTerminalKey('local', '/other'), ownerLauncherId: 'launcher-a', session },
        warmKey: KEY,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('没有 workspace（warmKey 为 null）时不能靠「两个都没有键」凑成相等', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
        warmKey: null,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('槽为空时 slotHeld 为假 —— promote 之后靠这个值重新预热', () => {
    expect(
      warmTerminalPreview({ warmTerminal: null, warmKey: KEY, launcherId: 'launcher-a' })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('slotHeld 与归属无关 —— 否则同胞之间会无限 ping-pong 重新预热', () => {
    // 这是 effect 依赖唯一允许读的量。若它跟着归属翻动：A 失去归属 → 依赖变化 → A 重新预热夺回
    // → B 失去归属 → B 夺回……两个同时在场的 launcher 永远互相打断，整个界面持续重渲染。
    const held = { key: KEY, ownerLauncherId: 'launcher-a', session }
    const owner = warmTerminalPreview({ warmTerminal: held, warmKey: KEY, launcherId: 'launcher-a' })
    const sibling = warmTerminalPreview({ warmTerminal: held, warmKey: KEY, launcherId: 'launcher-b' })
    expect(
      owner.slotHeld,
      'owner 与同胞对「槽在不在」判得不一样——这个量被归属污染了'
    ).toBe(sibling.slotHeld)
    // 前提自检：这一对必须真的在归属上分开，否则上面这条可以靠「两个都是 owner」而恒真。
    expect(owner.session, '前提落空：owner 侧没拿到 session').not.toBeNull()
    expect(sibling.session, '前提落空：同胞侧也拿到了 session，这一对没有分开').toBeNull()
  })
})

describe('store：同 key 再请求转移归属，不重开 PTY', () => {
  const initialState = useAppStore.getState()
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  const workspace: WorkspaceRecord = {
    id: 'workspace', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder'
  }
  const config: AppConfig = {
    version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }

  it('归属转给后来的 launcher，且 ready / session 原样保留', () => {
    // 若这里直接 return（旧写法），槽的 owner 永远停在第一个挂载的那个 launcher 上，用户刚点出来、
    // 正在看的那个只能显示冷卡片。转移归属让「最后一个请求预热的 launcher 拥有预览」，同时仍然
    // 只有一个 PTY、只有一个 view 挂在上面。
    const session = terminalSession('warm-1')
    const ready = Promise.resolve(session)
    useAppStore.setState({
      config,
      warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', ready, session }
    })

    useAppStore.getState().prewarmTerminal(workspace.id, 'launcher-b')

    const held = useAppStore.getState().warmTerminal
    expect(held?.ownerLauncherId, '归属没有转移——后挂载的 launcher 永远只能看冷卡片').toBe('launcher-b')
    expect(held?.ready, '转移归属时把 ready 换掉了——等于重开了一个 PTY').toBe(ready)
    expect(held?.session, '转移归属时丢了已经起好的 session').toBe(session)
  })

  it('归属已经是自己时不动任何东西（对象身份不变）', () => {
    const session = terminalSession('warm-1')
    const before = { key: KEY, ownerLauncherId: 'launcher-a', ready: Promise.resolve(session), session }
    useAppStore.setState({ config, warmTerminal: before })

    useAppStore.getState().prewarmTerminal(workspace.id, 'launcher-a')

    expect(useAppStore.getState().warmTerminal, '无变化的请求也写了一次 state').toBe(before)
  })
})

describe('接线层：组件的两个取值来自同一次判定', () => {
  // 上面两组是行为断言，但「组件真的调了这个函数」它们看不见——本仓没有 DOM 环境，
  // renderToStaticMarkup 不跑 effect，而且 zustand 在 SSR 下渲染 initial state，所以测试的
  // setState 对 markup 不可见。所以接线只能守形状，判据取 AST 而不是文本。
  const SOURCE = readFileSync(
    new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url).pathname,
    'utf8'
  )
  const ast = ts.createSourceFile(
    'NewTabSurface.tsx', SOURCE, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX
  )

  function callsNamed(name: string, within: ts.SourceFile = ast): ts.CallExpression[] {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(within)
    return found
  }

  /**
   * 这个名字在**它的调用点上**解析到的，是不是 `moduleSpecifier` 的那个具名 import。
   *
   * 为什么不用文本判据（这道判据此前就是那样，被 review 抓出来）：原写法是
   * `expect(SOURCE).toMatch(/from '\.\.\/lib\/warm-terminal-preview'/u)`——它只问「这个**路径串**在文件里
   * 出现过吗」，既不问是谁被 import 了，也不问那个名字有没有被本地声明盖掉。于是在这个文件上它是
   * **恒真**的：同一行还 import 了 `warmLauncherId`，所以哪怕把 `warmTerminalPreview` 从 import 里摘掉、
   * 在下面另写一个同名局部函数，路径串照旧在场。实测那次变异（摘掉 import + 本地写一个恒返回
   * `{session:null,pending:false,slotHeld:false}` 的同名函数）：**15 passed (15)**，与基线逐字相同。
   * 后果是真的——那个局部替身让整块预热预览恒为空，用户永远只看得到冷卡片，而这个文件里其余
   * 14 条行为断言全都测的是那个**没人再调用**的纯函数，一条都不会红。
   *
   * 为什么判据必须落在**调用点的作用域链**上，而不是「顶层有没有同名声明」：那是我这道修复的第一版，
   * 它把作用域模型取错了，实测**存活**。带 import 时顶层再写一个同名声明是非法 TS（TS2440），所以
   * 「顶层影子」这条路只有在**同时摘掉 import** 时才可达——那次正是被 `imported` 那一半抓住的，与影子
   * 判据无关。真正可达的形状是**内层**影子：import 原样留着，在组件函数体里写一个同名 function。实测
   * 那次变异（`function warmTerminalPreview(_i: unknown): WarmTerminalPreview { return {session:null,
   * pending:false,slotHeld:false} }` 插在调用点上方）：**16 passed (16)** 且 `tsc --noEmit` exit=0——
   * 顶层扫描对它完全失明，而 TS 合法所以编译器也不吭声。（本仓 lexical-boundaries-need-a-real-lexer：
   * 「范围豁免要用语言自己的作用域规则」。）
   *
   * 判据因此是：从每个调用点往外走作用域链，第一个声明这个名字的地方必须是那条 ImportDeclaration。
   *   · 走 TS parser 而不是正则——正则对 `as` 别名、多行 import、注释里的假路径都会判错。带 `as` 别名时
   *     按**本地名**算：本地名才是调用点写的那个标识符。
   *   · 途中任何一层声明了同名即判 shadowed。「哪些形状算一层声明」是这道判据真正的判据，所以它不写在
   *     散文里而是列成 `SHADOW_FORMS` 表，逐条由自检质询——散文说覆盖了什么不算覆盖（本仓
   *     comment-promises-more-than-assertion）。这一版之前的散文就点名了 catch 而实现里没有 catch。
   *
   * 为什么「哪些节点是一层作用域」必须逐种列而不能按语法形状猜：TS 引入词法绑定的位置并不都在
   * `statements` 里，而第一版恰好只看 `statements` + `parameters`，于是下面每一种都是**合法 TS**、
   * 都能声明同名标识符、都对判据完全隐身（各自的靶子见 `SHADOW_FORMS`）：
   *   · `catch (name)` —— 绑定挂在 CatchClause 上，不在它的 Block 里；
   *   · `for (let name = …)` / `for (const name of …)` / `for (const name in …)` —— 循环变量挂在语句上，
   *     且是 VariableDeclarationList 而不是 VariableStatement，所以连 `declares` 都认不出；三种是三个
   *     节点类型，各自要有靶子；
   *   · `case 1: const name = …`（**不带花括号**）与 `default: const name = …` —— CaseClause/DefaultClause
   *     自己持 statements，它们不是 Block；带花括号那种落在 Block 上，写成带花括号的靶子会让这两条
   *     分支无人守（实测：删掉 CaseClause 分支时带花括号的靶子照旧全绿）；
   *   · `function f({ name })` 与 `const { name } = m` —— 绑定名是 BindingPattern 不是 Identifier。
   *
   * 「认出来了」不等于「走的是那条分支」，所以 `SHADOW_FORMS` 每条都带 `via`，由 `resolveDetail`
   * 回报的 `viaKinds` 见证；覆盖自检则从实现正文里抓 kind 串与 `via` 集合**两向相等**，而不是过滤
   * 一张手抄清单——过滤只能发现「删了分支」，发现不了「加了没人质询的分支」（实测存活过一次）。
   *
   * 盲点（亲口申报）：只看词法声明，不做真类型解析。`import * as m` 后 `const warmTerminalPreview =
   * m.warmTerminalPreview` 会被算成影子（保守，会打红而非放过）；而把 lib 那个文件本身改坏，这条判据
   * 看不见——那由前两个 describe 的 9 条行为断言守（7 条直测 warmTerminalPreview 的取值、2 条测 store
   * 的归属转移），加上本 describe 里直测 warmLauncherId 取值的那一条。数字取自实跑输出的用例清单。
   */
  function resolveDetail(
    name: string,
    moduleSpecifier: string,
    within: ts.SourceFile = ast
  ): { imported: boolean; shadowed: boolean; viaKinds: string[] } {
    let importDeclaration: ts.Node | undefined
    for (const statement of within.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === moduleSpecifier &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        // 本地名（`x as y` 时是 `y`）才是调用点写的那个标识符。
        statement.importClause.namedBindings.elements.some((element) => element.name.text === name)
      ) {
        importDeclaration = statement
      }
    }

    // 「这个节点声明了 name 吗」——按声明种类逐个问，不按语法形状猜。
    // 绑定名一律走 `bindsName`：`const { warmTerminalPreview } = m` / `function f({ warmTerminalPreview })`
    // 的名字挂在 BindingPattern 上而不是 Identifier 上，只判 `ts.isIdentifier(node.name)` 会整族漏掉。
    const bindsName = (target: ts.BindingName): boolean => {
      if (ts.isIdentifier(target)) return target.text === name
      return target.elements.some(
        (element) => !ts.isOmittedExpression(element) && bindsName(element.name)
      )
    }

    const declares = (node: ts.Node): boolean => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name
      if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        return ts.isIdentifier(node.name) && node.name.text === name
      }
      if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return node.name.text === name
      // VariableStatement 走 declarationList；`for (let x = …)` 的 list 不挂在 statement 上，
      // 所以 list 自己也要能被直接问一次（见 scopeCandidates 里的循环初始化式）。
      if (ts.isVariableStatement(node)) return declares(node.declarationList)
      if (ts.isVariableDeclarationList(node)) {
        return node.declarations.some((declaration) => bindsName(declaration.name))
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
        return bindsName(node.name)
      }
      return false
    }

    /**
     * `cursor` 这一层作用域里**直接**引入的绑定，连同**是哪一种作用域形状**供出来的。
     *
     * 一层作用域不等于「它的 statements」：TS 有几处把绑定挂在语句自身而不是块里，第一版只看
     * statements + parameters，于是它们全部隐身。
     *
     * 每条返回值都带 `kind`，因为「认出来了」不等于「走的是那条分支」：`case 1: { const x = … }`
     * 的绑定其实落在 Block 里，靶子照旧能过，于是 CaseClause 那条分支删掉也没人红（实测：删掉
     * CaseClause 只有覆盖自检红，行为靶子全绿）。`SHADOW_FORMS` 因此逐条断言 `viaKinds` 里必须
     * 出现它声称的那一种，这样每条分支各有一个只杀它自己的靶子。
     */
    const scopeCandidates = (cursor: ts.Node): { node: ts.Node; kind: string }[] => {
      const candidates: { node: ts.Node; kind: string }[] = []
      const push = (node: ts.Node | undefined, kind: string): void => {
        if (node) candidates.push({ node, kind })
      }
      if (ts.isSourceFile(cursor) || ts.isBlock(cursor) || ts.isModuleBlock(cursor)) {
        for (const statement of cursor.statements) push(statement, 'Block')
      }
      if (ts.isFunctionLike(cursor)) {
        for (const parameter of cursor.parameters) push(parameter, 'Parameter')
      }
      // `catch (e)` 的绑定挂在 CatchClause 上，它的 Block 里没有这条声明。
      if (ts.isCatchClause(cursor)) push(cursor.variableDeclaration, 'CatchClause')
      // 循环变量挂在语句上，且 for-in/for-of 的初始化式就是 VariableDeclarationList 本身。
      if (ts.isForStatement(cursor)) push(cursor.initializer, 'ForStatement')
      if (ts.isForInStatement(cursor)) push(cursor.initializer, 'ForInStatement')
      if (ts.isForOfStatement(cursor)) push(cursor.initializer, 'ForOfStatement')
      // CaseClause / DefaultClause 自己持 statements 且不是 Block——`case 1: const x = …`（不带花括号）
      // 就在这儿；带花括号那种落在 Block 上，所以靶子必须写不带花括号的形状。
      if (ts.isCaseClause(cursor)) {
        for (const statement of cursor.statements) push(statement, 'CaseClause')
      }
      if (ts.isDefaultClause(cursor)) {
        for (const statement of cursor.statements) push(statement, 'DefaultClause')
      }
      return candidates
    }

    // 从调用点往外走作用域链，找第一个声明这个名字的地方。
    let shadowed = false
    let imported = false
    const viaKinds = new Set<string>()
    for (const call of callsNamed(name, within)) {
      let resolved: ts.Node | undefined
      let cursor: ts.Node | undefined = call
      while (cursor && !resolved) {
        for (const candidate of scopeCandidates(cursor)) {
          if (candidate.node !== call && declares(candidate.node)) {
            resolved = candidate.node
            viaKinds.add(candidate.kind)
          }
        }
        if (!resolved && cursor === within && importDeclaration) resolved = importDeclaration
        cursor = cursor.parent
      }
      if (resolved === importDeclaration && importDeclaration !== undefined) imported = true
      else shadowed = true
    }
    // 零调用点时 `imported` 会是 false——那由「恰好被调用一次」那条断言先红，这里不替它兜。
    return { imported, shadowed, viaKinds: [...viaKinds].sort() }
  }

  /** 主判据只关心这两个量；`viaKinds` 是给 `SHADOW_FORMS` 自检用的分支见证。 */
  const resolvesToImport = (
    name: string,
    moduleSpecifier: string,
    within: ts.SourceFile = ast
  ): { imported: boolean; shadowed: boolean } => {
    const { imported, shadowed } = resolveDetail(name, moduleSpecifier, within)
    return { imported, shadowed }
  }

  const PREVIEW_MODULE = '../lib/warm-terminal-preview'

  const probe = (...lines: string[]): ts.SourceFile =>
    ts.createSourceFile(
      'probe.tsx', lines.join('\n'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX
    )

  /**
   * 「哪些形状算一层同名声明」的清单——判据真正的判据。
   *
   * 每一条都是**合法 TS**、都让调用点解析到影子而不是 import，而它们在第一版（只看
   * `statements` + `parameters`）里全部隐身。散文点名过 catch 却没有实现它，所以这里改成逐条
   * 由自检质询：每个形状一个独立的 it（`it.each`），不合并成一条断言——一个 it 里两个 expect 时
   * 先失败的那个让后面成死代码，于是「只杀第二半」的变异会被读成已被守住（本仓
   * two-throws-in-one-it-mask-each-other）。
   */
  const SHADOW_FORMS: { form: string; via: string; lines: string[] }[] = [
    {
      form: '函数体内的同名 function（实测存活过的那次变异形状）',
      via: 'Block',
      lines: [
        'function Surface() {',
        '  function warmTerminalPreview(_i: unknown) { return { session: null } }',
        '  return warmTerminalPreview({})',
        '}'
      ]
    },
    {
      form: 'catch 绑定（绑定挂在 CatchClause 上，不在它的 Block 里）',
      via: 'CatchClause',
      lines: [
        'function Surface() {',
        '  try { return null } catch (warmTerminalPreview) { return warmTerminalPreview({}) }',
        '}'
      ]
    },
    {
      form: 'for 的循环变量（挂在语句上，且是 VariableDeclarationList 不是 VariableStatement）',
      via: 'ForStatement',
      lines: [
        'function Surface() {',
        '  for (let warmTerminalPreview = 0; warmTerminalPreview < 1; warmTerminalPreview++) {',
        '    return warmTerminalPreview({})',
        '  }',
        '  return null',
        '}'
      ]
    },
    {
      form: 'for-of 的循环变量（初始化式本身就是 VariableDeclarationList）',
      via: 'ForOfStatement',
      lines: [
        'function Surface(items: unknown[]) {',
        '  for (const warmTerminalPreview of items) { return warmTerminalPreview({}) }',
        '  return null',
        '}'
      ]
    },
    {
      form: 'for-in 的循环变量（与 for-of 分开列：它是另一种节点，各删一个都要有人红）',
      via: 'ForInStatement',
      lines: [
        'function Surface(m: Record<string, unknown>) {',
        '  for (const warmTerminalPreview in m) { return warmTerminalPreview({}) }',
        '  return null',
        '}'
      ]
    },
    {
      form: 'case 1 的裸 const（不带花括号——带了就落在 Block 上，那样这条分支无人守）',
      via: 'CaseClause',
      lines: [
        'function Surface(k: number) {',
        '  switch (k) {',
        '    case 1:',
        '      const warmTerminalPreview = (_i: unknown) => ({ session: null })',
        '      return warmTerminalPreview({})',
        '    default: return null',
        '  }',
        '}'
      ]
    },
    {
      form: 'default 子句的裸 const（DefaultClause 与 CaseClause 是两种节点，各自要有靶子）',
      via: 'DefaultClause',
      lines: [
        'function Surface(k: number) {',
        '  switch (k) {',
        '    case 1: return null',
        '    default:',
        '      const warmTerminalPreview = (_i: unknown) => ({ session: null })',
        '      return warmTerminalPreview({})',
        '  }',
        '}'
      ]
    },
    {
      form: '解构形参（绑定名是 BindingPattern 不是 Identifier）',
      via: 'Parameter',
      lines: [
        'function Surface({ warmTerminalPreview }: { warmTerminalPreview: (i: unknown) => unknown }) {',
        '  return warmTerminalPreview({})',
        '}'
      ]
    },
    {
      form: '对象解构的 const（同上，且要能穿过嵌套/重命名）',
      via: 'Block',
      lines: [
        'function Surface(m: Record<string, (i: unknown) => unknown>) {',
        '  const { nested: { warmTerminalPreview } } = { nested: m }',
        '  return warmTerminalPreview({})',
        '}'
      ]
    }
  ]

  it('warmTerminalPreview 恰好被调用一次', () => {
    // 两处调用意味着两个取值各算了一遍——那正是要消除的双重判定。零处意味着组件绕过了这个函数。
    const calls = callsNamed('warmTerminalPreview')
    expect(calls, `实测调用点 ${calls.length} 处，应为 1 处`).toHaveLength(1)
  })

  it('从 lib/warm-terminal-preview import，不是本地同名函数', () => {
    // 判「调用点上这个名字解析到哪」，而不是「那个路径串在文件里出现过」——见 resolvesToImport 的头注。
    const { imported, shadowed } = resolvesToImport('warmTerminalPreview', PREVIEW_MODULE)
    expect(imported, `warmTerminalPreview 不是从 ${PREVIEW_MODULE} 具名 import 的`).toBe(true)
    expect(shadowed, 'warmTerminalPreview 的调用点解析到了一个同名局部声明——上一条数到的调用点打给了影子').toBe(false)
  })

  // 反向自证，且**走真函数**（`resolvesToImport` 收 `within` 就是为了这个）：自检里手抄一份扫描逻辑，
  // 等于让判据给自己背书——本仓 comment-promises-more-than-assertion 那族，我在 #685 亲手犯过一次。
  it.each(SHADOW_FORMS)('判据自检：认得出这种同名影子——$form', ({ lines, via }) => {
    const sample = probe(
      `import { warmLauncherId, warmTerminalPreview } from '${PREVIEW_MODULE}'`,
      ...lines
    )
    const detail = resolveDetail('warmTerminalPreview', PREVIEW_MODULE, sample)
    expect(
      { imported: detail.imported, shadowed: detail.shadowed },
      '这个形状没被认出来——主断言对它是恒真的，import 照旧在场而调用点打给了影子'
    ).toEqual({ imported: false, shadowed: true })
    // 并且必须是**它声称的那条分支**供出来的绑定。少了这一条，靶子只证「认出来了」：
    // `case 1: { const x = … }` 的绑定其实落在 Block 上，于是删掉 CaseClause 分支它照旧全绿
    // （实测：那次变异只有覆盖自检红）。有了这一条，每条分支都各有一个只杀自己的靶子。
    expect(
      detail.viaKinds,
      `这个靶子没走 ${via} 那条分支（实际是 ${detail.viaKinds.join('/') || '无'}）——它守不住那条分支`
    ).toContain(via)
  })

  it('判据自检：SHADOW_FORMS 覆盖了实现里每一种作用域形状', () => {
    // 在场自检：上面那族 it.each 只能证「表里的形状都被认出来」，不能证「实现新增的分支有人质询」。
    // 判据方向必须是**从实现派生**而不是过滤一张手抄清单：第一版写成
    // `shapes.filter((s) => body.includes(s))`，于是只有**删**分支会红，**加**一条没靶子的分支
    // 照旧全绿（实测：插入 `ts.isConditionalExpression` 分支后 25 条全绿）——而那恰是这条自检
    // 声称要防的方向。现在把 kind 串从正文里抓出来，与表里 via 的集合两向相等。
    const guardSource = readFileSync(new URL(import.meta.url).pathname, 'utf8')
    const scopeBody = guardSource.slice(
      guardSource.indexOf('const scopeCandidates'),
      guardSource.indexOf('// 从调用点往外走作用域链')
    )
    expect(scopeBody.length, 'scopeCandidates 的正文没切到——这条自检在空串上恒真').toBeGreaterThan(200)
    // 每次 push 的第二个实参就是那条分支的 kind 串，这是实现自己的清单。
    const declared = [...new Set([...scopeBody.matchAll(/push\([^,]+,\s*'([A-Za-z]+)'\)/gu)].map((m) => m[1]!))]
    expect(declared.length, 'kind 串一个都没抓到——正则与 push 的写法脱节，这条自检会恒真').toBeGreaterThan(5)
    expect(
      declared.sort(),
      'scopeCandidates 供出的作用域形状与 SHADOW_FORMS 的 via 对不上——加了分支就要加靶子'
    ).toEqual([...new Set(SHADOW_FORMS.map((entry) => entry.via))].sort())
  })

  it('判据自检：干净样本不误报', () => {
    // 另一极：判据不能恒红，否则健康代码永远打假红。
    const clean = probe(
      `import { warmLauncherId, warmTerminalPreview } from '${PREVIEW_MODULE}'`,
      'function Surface() { return warmTerminalPreview({}) }'
    )
    expect(
      resolvesToImport('warmTerminalPreview', PREVIEW_MODULE, clean),
      '干净样本被判成有影子/未 import——健康代码会被打假红'
    ).toEqual({ imported: true, shadowed: false })
  })

  it('判据自检：路径串在场不足以过关', () => {
    // 这是原判据（路径子串）恒真的那个形状：路径串在场，但带进来的是**另一个**符号。
    // 与上一条分开成两个 it：合在一条里时先失败的那个会让后面成死代码。
    const otherSymbol = probe(
      `import { warmLauncherId } from '${PREVIEW_MODULE}'`,
      'function warmTerminalPreview(_i: unknown) { return { session: null } }',
      'function Surface() { return warmTerminalPreview({}) }'
    )
    expect(
      resolvesToImport('warmTerminalPreview', PREVIEW_MODULE, otherSymbol),
      '路径串在场就被判成 import 了——那正是被 review 抓出来的原判据'
    ).toEqual({ imported: false, shadowed: true })
  })

  it('组件里不许再自己拿 warmTerminal 的 key / 归属判一次', () => {
    // 判定只在纯函数里做一次。组件若再读这两个字段，就是同一个概念的第二处判定，两处必然漂移。
    const offenders: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === 'ownerLauncherId' || node.name.text === 'key') &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'warmTerminal'
      ) {
        offenders.push(
          `${node.name.text} @ 行 ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(offenders, [
      '组件直接读了 warmTerminal 的归属字段。归属判定只许在 lib/warm-terminal-preview.ts 里做一次，',
      '组件读一遍就是第二处判定——两处会漂移，症状是「转圈提示归 A、终端画面归 B」。'
    ].join('\n')).toEqual([])

    // 前提自检：分析器认得出这一族属性访问。用一段一定命中的样本质询它，否则上面可能恒绿。
    const probe = ts.createSourceFile(
      'probe.tsx',
      'const x = warmTerminal.ownerLauncherId === launcherId && warmTerminal.key === k',
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    )
    const probeHits: string[] = []
    const probeVisit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === 'ownerLauncherId' || node.name.text === 'key') &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'warmTerminal'
      ) probeHits.push(node.name.text)
      ts.forEachChild(node, probeVisit)
    }
    probeVisit(probe)
    expect(probeHits, '分析器认不出它要禁的形状——主断言恒绿').toEqual(['ownerLauncherId', 'key'])
  })

  it('归属键由 warmLauncherId 判一次，不直接用可缺席的 regionId', () => {
    // 空分组占位没有 regionId，而那恰是新建 workspace 的第一眼。用可缺席的字段当归属键会把最主要
    // 那条路径永久降级成冷卡片（实测：new-tab-resource-contract 当场打红）。
    const calls = callsNamed('warmTerminalPreview')
    expect(calls, '调用点不是一处——上一条会先红').toHaveLength(1)
    const argument = calls[0]!.arguments[0]
    expect(argument && ts.isObjectLiteralExpression(argument), '实参不是对象字面量').toBe(true)
    const keys = (argument as ts.ObjectLiteralExpression).properties.map((property) => (
      property.name && ts.isIdentifier(property.name) ? property.name.text : ''
    ))
    expect(keys, `实参键是 [${keys.join(', ')}]，归属键必须是 launcherId`).toContain('launcherId')
    expect(keys, 'regionId 又被当成归属键了——空分组占位没有 region').not.toContain('regionId')
    // 键的取值规则只许在 lib 里做一次：组件若自己写 `regionId ?? tabGroupId` 之类，「缺 region 时
    // 退到什么」就有了第二处判断，两处必然漂移。
    const launcherIdCalls = callsNamed('warmLauncherId')
    expect(
      launcherIdCalls,
      `warmLauncherId 调用点 ${launcherIdCalls.length} 处，应为 1 处——归属键的取值规则只许判一次`
    ).toHaveLength(1)
    // 与上面 warmTerminalPreview 同一族判据：正则 `import \{[^}]*\bwarmLauncherId\b[^}]*\}` 对别名与
    // 多行 import 都成问题，且它同样不问「调用点解析到谁」——在组件函数体里写一个同名 warmLauncherId
    // 就能让上面那条「恰好一处调用」打给替身而全绿（那正是 warmTerminalPreview 侧实测存活的形状）。
    const launcherIdResolution = resolvesToImport('warmLauncherId', PREVIEW_MODULE)
    expect(launcherIdResolution.imported, `warmLauncherId 不是从 ${PREVIEW_MODULE} 具名 import 的`).toBe(true)
    expect(launcherIdResolution.shadowed, 'warmLauncherId 的调用点解析到了同名局部声明——那一处调用打给了影子').toBe(false)
  })

  it('warmLauncherId 缺 region 时退到 group，且两个命名空间不会撞', () => {
    // 这是「归属键永远在场」的行为面。空分组占位（WorkspaceWorkbench 里 bodyTabs 为空那条）没有
    // region，此时必须仍然给出一个键；同时它不能与任何 region 键相等，否则空占位会冒充某个 region
    // 的 owner，把那个 region 的预览抢走。
    expect(warmLauncherId({ tabGroupId: 'group-1', regionId: undefined })).toBe('group:group-1')
    expect(warmLauncherId({ tabGroupId: 'group-1', regionId: 'region:abc' })).toBe('region:region:abc')
    // 同一个 group 里的两个 region 互不相同（分屏那条路径）。
    expect(
      warmLauncherId({ tabGroupId: 'g', regionId: 'r1' })
    ).not.toBe(warmLauncherId({ tabGroupId: 'g', regionId: 'r2' }))
    // 跨命名空间不撞：一个 group 叫 `x`、一个 region 也叫 `x` 时两个键必须分开。
    expect(
      warmLauncherId({ tabGroupId: 'x', regionId: undefined })
    ).not.toBe(warmLauncherId({ tabGroupId: 'other', regionId: 'x' }))
  })

  it('预热 effect 的依赖带上「槽在不在」，且那个量与归属无关', () => {
    // promote 会把槽清空。依赖里只有 workspace 与 visible 时，仍然在场的同胞 launcher 此后永远
    // 看不到热 shell——它的 Terminal 卡片静默退化成冷路径，本次会话再不恢复。
    //
    // 而这个量**不能**带归属：归属在同胞之间转移，若依赖跟着归属翻动，失去归属的那个立刻重新预热
    // 夺回来，对方随即再夺回——无限 ping-pong。所以依赖必须是 slotHeld 这个与归属无关的量。
    const calls = callsNamed('prewarmTerminal')
    expect(calls, 'prewarmTerminal 调用点不是一处——new-tab-prewarm-visible-only 会先红').toHaveLength(1)

    // 找到包住这次调用的 useEffect，读它的依赖数组。
    let effect: ts.CallExpression | undefined
    let node: ts.Node | undefined = calls[0]
    while (node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useEffect'
      ) { effect = node; break }
      node = node.parent
    }
    expect(effect, '那次调用不在 useEffect 里——判据落空').toBeDefined()

    const deps = effect!.arguments[1]
    expect(deps && ts.isArrayLiteralExpression(deps), 'useEffect 第二个实参不是数组字面量').toBe(true)
    const names = (deps as ts.ArrayLiteralExpression).elements.map((element) => element.getText(ast))
    expect(names, [
      `预热 effect 的依赖是 [${names.join(', ')}]，其中没有表达「槽在不在」的项。`,
      'promote 清空槽之后没有任何依赖变化，同胞 launcher 因此永远停在冷路径。'
    ].join('\n')).toContain('warmSlotHeld')
    // `visible` 也必须在依赖里：泊车的 launcher 挂载时不可见故不预热，变可见时若依赖不含 visible
    // 就没有任何东西触发预热，它永远停在冷卡片。（极性——只在 visible 为真时预热——由
    // new-tab-prewarm-visible-only.test.ts 用 AST 数出口守。）
    expect(names, `依赖是 [${names.join(', ')}]，缺 visible：泊车 launcher 变可见时不会预热`)
      .toContain('visible')
    // 带归属的那两个量绝不许进依赖：进了就是同胞之间无限互相夺回归属。
    for (const forbidden of ['warmSession', 'warmPending']) {
      expect(names, [
        `依赖里出现了 ${forbidden}——它带归属，会在同胞之间震荡：`,
        'A 失去归属→依赖变化→A 重新预热夺回→B 失去归属→B 夺回……界面持续重渲染。'
      ].join('\n')).not.toContain(forbidden)
    }
  })
})
