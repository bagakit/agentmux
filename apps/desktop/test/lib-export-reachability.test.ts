import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parseTsx, readAndParse } from './helpers/effect-reachability.js'

// ---------------------------------------------------------------------------
// renderer 的 `lib/` 里，每个 `export` 都得有人消费。
//
// `export` 是一句**断言**：「这个名字有本文件之外的消费者」。没有消费者时它是假的，而代价不只是
// 几行死代码——本仓记过两次更贵的形态：
//   · 「promised-accessor-never-landed」：注释写明「唯一调用方是 X」而 X 从来不存在；
//   · 「declared-capability-silently-not-done」：声明了能力却没有消费者，于是那条轴上的谎言免检。
// 本轮实测到的正是第一种：`rosterBadgeCount` 的 docstring 说它是「折叠花名册徽标的计数」
// （agent-roster.ts）、`attention-event.ts` 又说「行内强调与折叠花名册徽标都读这个」，而那个徽标
// **从未被建造**（AgentRoster 折叠态渲染的是中性总数）。两处注释互相印证，读起来像已交付的接线。
//
// ─── 判据为什么是「不动点」，而不是「名字在别的文件里出现过」───
//
// 后者是最容易写的判据，且**实测不可用**：在引入这道门的那一刻（`d6c7c37^` = `d272316`，136 个
// lib 模块 / 771 个导出）它报出 132 个（17%），绝大多数是误报。原因是导出的**类型**常常只在自己文件里被
// 点名，而在调用点是靠**推断**
// 消费的——例如 `TabDropZone` 只出现在同文件的 `Exclude<TabDropZone, 'center'>` 里，可它是
// `resolvePaneColumnEdgeZone` 返回类型的一部分，每个调用方都在用它。「名字没在别处出现」因此
// 不等于「没有消费者」。
//
// 所以判据取**可达性不动点**（沿用 packages/core/test/control-export-reachability.test.ts 的形状）：
//   种子：在**定义文件之外**被提到过名字的导出；
//   闭包：同一个文件里，凡是声明了「已活」名字的那条语句，它引用到的导出也算活——
//        并且**不分那条声明有没有 export**（非导出的本地 helper 也传递可达性）。
//        少了「不分导出」这一条，「只被同文件的私有 helper 消费」的导出会被误报成孤儿。
//        **这一条今天在本仓没有任何真实见证**：实测把闭包收窄成只走导出声明，整棵树的裁决一字不变
//        （两种写法都是 0 个孤儿），也就是说它保护的形状此刻一个实例都不存在。所以它由下面
//        「自检 3」用一个**合成模块**钉住，理由写在那条断言里。
//   迭代到不动点，剩下的就是**任何地方都没有消费者**的导出。
// 同一份输入（`d272316`）下，不动点把 132 收敛到 2。差额 130 个全是靠闭包翻身的：**116 个类型 +
// 14 个取值**，全是上面那类「只在自己文件里被点名、在调用点靠推断消费」的误报。
//
// 这些规模数**必须测在提交内容上**，不能测脏工作树。本注释前两版都栽在这一点上：第一版把
// `134→2`（提交前）与 `131 / 13 个取值`（提交后）拼在一句话里，差额算不平；第二版数字自洽了，
// 但两组数（`779 / 138 / 134` 与「今天的树 776 / 131」）都取自**脏工作树**——多出来的差额全来自
// 两个从未入库的 lib 文件（`git status` 里的 `??`）被算进了扫描面。内部算术仍自洽，所以「差额算
// 不平」那种指纹**抓不到这一族**，坏的是 provenance。
// 测量命令（走 `git archive <ref>` 抽出提交内容，再在那棵树上跑本文件的判据逻辑）实测：
//   `d272316`（= `d6c7c37^`，这道门引入前）：136 模块 / 771 导出 / 132 naive / 2 孤儿 / 130 翻身（116 类型 + 14 取值）
//   `d6c7c37`（引入这道门、清掉那 2 个遗孤）：136 模块 / 768 导出 / 129 naive / **0** 孤儿 / 129 翻身（116 类型 + 13 取值）
// 那 2 个遗孤是 `lib/control.ts listWorkbenchControlRegions` 与 `lib/executors.ts configuredExecutorLabel`。
// 再往后（`3050ddf`、`f36275a`）这四个数一字未变。要更新这段数字，**重新跑那个 archive 测量**，
// 别读工作树。
//
// ─── 这条判据**只**保证什么，**不**保证什么 ───
//
//   保证：新增一个谁也不用的导出会红；删掉某个导出的最后一个消费者、而导出留在原地，也会红。
//        这句话由「自检 4」（合成目录树）证——真实树上 0 个孤儿，主判据永远是 `toEqual([])`，
//        它自己**证不了**这一点。别把它记到自检 2 名下：那条只证「闭包不跨文件」。
//
//   **不**保证：
//     - 它按**标识符名**匹配，不做符号解析。同名的两个不同实体它分不开，于是它会**偏向判活**
//       （另一个文件里有个同名局部变量就足以当种子）。这是刻意的保守方向：误判活只是漏报一个
//       孤儿，误判死会让人删掉在用的代码。
//     - 消费面**只含生产代码**（renderer/src），**不含 test/**。「只被测试引用」正是零生产消费者，
//       是要抓的东西，不是让判据变绿的理由——此前把 test/ 折进消费面，正是这道门放过 `rosterBadgeCount`
//       的原因。但「只被测试引用」在本仓有两类含义，都进 DELIBERATE 豁免表、都必须带一句**可断言**的
//       premise：
//         · 合法 test-only——结构守卫的 SSOT 枚举器、或为可测性抽出的纯 helper。留着导出是对的：删了它，
//           那道遍历它的测试守卫就失明。
//         · 未接线的死承诺——描述了一段从未落地、或仍被别处阻塞的接线（本轮 `rosterBadgeCount` 正是这样：
//           它的 docstring 曾把一个从未建造的折叠徽标写得像已交付的接线）。
//       两类的 premise 必须**如实**说明是哪一类，死承诺就得写「无生产消费者、接线从未落地」，不许伪装成
//       已交付。表的封闭性靠**钉死条数**（自检「豁免表条数」）保证，不是计数地板——本仓记过
//       「count-floor-is-not-closedness」：地板只买到运气，钉死的字面量才逼每次增删都过一次 review。
//       每条还被逐条质询：指向真实导出、**仍是**生产孤儿（接上生产消费者就删掉这条）、且**确有**测试消费者
//       （否则它是零消费者的死代码，该删不该豁免）。豁免逐条列在 DELIBERATE，三类形态记忆见
//       「forbidden-list-guard-always-leaks」——所以豁免的判据是「只允许这张具名表里的」，而不是禁止清单。
//     - 它看不见「该私有」这一类。只被自己文件消费的导出被闭包**正确地**判成活的——它确实有
//       消费者，只是那个消费者在同一个文件里。上面那 132 个里就混着这一类（本轮把
//       `tab-drop-zone.ts` 那个 tab 条高度常量降级为私有，靠的是 review 不是这道门）。降级为
//       私有是另一条规则，需要另一个判据，别指望这里兜。
//     - 它只看 `lib/`。components/、hooks/、store.ts 的导出不在扫描面内（那些文件里 Props 类型
//       只在本文件被点名、由 JSX 推断消费的比例高得多，同一判据在那里的信噪比未实测）。
// ---------------------------------------------------------------------------

const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const LIB_DIR = `${RENDERER_SRC}/lib`
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))

function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.tsx?$/u.test(entry))
    .map((entry) => `${root}/${entry}`)
}

/** 这个语句导出了哪些名字。覆盖本仓真实出现的每种写法。 */
function exportedNames(statement: ts.Statement): string[] {
  const isExported = (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    // `export { x }` / `export { x as y }`——对外的名字是 `y`。
    return statement.exportClause.elements.map((element) => element.name.text)
  }
  if (!isExported) return []
  if (ts.isVariableStatement(statement)) {
    // 一条 `export const a = 1, b = 2` 声明两个名字，别只取第一个。
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text)
  }
  const named = statement as ts.Statement & { name?: ts.Node }
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}

/**
 * 这个语句声明了哪些名字——**不分导不导出**。
 *
 * 闭包要靠它传递「同文件组合」：私有 helper 被判活之后，它引用到的导出也活。漏掉非导出声明
 * 就会把「只被同文件私有函数消费」的导出误报成孤儿。
 */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text)
  }
  const named = statement as ts.Statement & { name?: ts.Node }
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}

/** 子树里出现过的全部标识符名。类型位也算——`typeof X` 里的 `X` 是标识符，会被收进来。 */
function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) names.add(current.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return names
}

/**
 * 一个**扫描面**：哪些 lib 文件受判、哪些文件算消费者。
 *
 * 做成参数而不是模块级常量，是为了让整条判据（取导出 → 种子 → 不动点 → 汇总成清单）能整体跑在
 * 一棵**合成目录树**上（见「自检 4」）。真实树上今天 0 个孤儿，于是每条真实文件断言都退化成
 * `toEqual([])`——一个恒返回 `[]` 的实现同样满足它们，这道门就没有任何见证（本仓记过
 * 「guard-whose-answer-is-always-empty」那一族：#624 实测把 `unconsumedExportsOf` 首行改成
 * `return []`，当时本文件那 4 条全绿）。合成面提供那个缺席的非空见证。
 *
 * 消费者的标识符索引在这里建**一次**：真实面有 500+ 个文件，每次调用重建会让这个 suite 慢一个
 * 数量级。
 */
function scanSurface(libFiles: string[], consumerFiles: string[]) {
  const identifiersByFile = new Map(consumerFiles.map((file) => [file, identifiersIn(readAndParse(file).sourceFile)]))
  /** 除 `exclude` 之外，有没有文件提到过这个名字。 */
  const mentionedOutside = (name: string, exclude: string): boolean => {
    for (const [file, identifiers] of identifiersByFile) {
      if (file !== exclude && identifiers.has(name)) return true
    }
    return false
  }
  /** 一个 lib 模块里，没有任何消费者的导出名。 */
  const unconsumedExports = (file: string): string[] =>
    unconsumedExportsOf(readAndParse(file).sourceFile, (name) => mentionedOutside(name, file))
  /** 整个面上的孤儿，形如 `<绝对路径> <名字>`。 */
  const orphans = (): string[] => libFiles.flatMap((file) => unconsumedExports(file).map((name) => `${file} ${name}`))
  return { libFiles, consumerFiles, mentionedOutside, unconsumedExports, orphans }
}

// 消费面**只含生产源码**（renderer/src），**故意不含 test/**：只被测试引用的导出正是零生产消费者，
// 那是要抓的，不是让判据变绿的理由。合法的 test-only 导出（SSOT 枚举器、为可测性抽出的纯 helper）
// 走下面的 DELIBERATE 豁免表，每条带一句可断言的 premise。
const real = scanSurface(sourceFilesUnder(LIB_DIR), sourceFilesUnder(RENDERER_SRC))

/**
 * 刻意保留的、零生产消费者的 lib 导出。
 *
 * 每条都必须带一句**可断言**的 `premise`——不是「刻意保留」，而是「为什么它今天该带着这个状态活着」。
 * 两类合法形态，`kind` 如实标注：
 *   - `'test-only'`：确有测试消费者且**应当**只被测试消费——结构守卫遍历的 SSOT 枚举器（删了导出，
 *     那道守卫就失明）、或为可测性从组件里抽出的纯谓词/纯 helper。
 *   - `'unwired'`：一段从未落地、或仍被别处阻塞的接线的一半。它**没有**生产消费者不是因为该私有，而是
 *     因为它承诺的东西还没建。premise 必须**如实**这么说，绝不许把死承诺写得像已交付（本轮
 *     `rosterBadgeCount` 正是这样被放过的）。
 *
 * 封闭性靠自检「豁免表条数钉死」保证——**不是**计数地板（本仓记过 count-floor-is-not-closedness：
 * 地板只买运气，钉死的字面量才逼每次增删过一次 review）。另有自检逐条质询：指向真实导出、仍是生产
 * 孤儿（接上生产消费者就删这条）、且确有测试消费者（否则它是零消费者死代码，该删不该豁免）。
 */
const DELIBERATE: ReadonlyArray<{
  module: string
  name: string
  kind: 'test-only' | 'unwired'
  premise: string
}> = [
  {
    module: 'lib/agent-roster.ts',
    name: 'rosterBadgeCount',
    kind: 'unwired',
    premise:
      '无生产消费者：它描述的折叠花名册徽标从未被建造（AgentRoster 折叠态渲染的是 total prop，' +
      'WorkspaceSidebar 的徽标是行内算的）。是否给窗口加这么一个 dock 徽标是一个待定的产品决策' +
      '（tracker 记为 deliberate），所以既不接线也不删除——只让这道门如实说出它未接线。'
  },
  {
    module: 'lib/attention-event.ts',
    name: 'ATTENTION_SORT_CLASSES',
    kind: 'test-only',
    premise:
      '排序类名的 SSOT，从 ATTENTION_SORT_RANK 的键派生。attention-ordering.test.ts 的结构守卫遍历它，' +
      '认出「谁又自己手抄了一份序表」——删了这个导出，那道守卫就没有权威清单可比，失明。'
  },
  {
    module: 'lib/attention-event.ts',
    name: 'URGENT_ATTENTION_CATEGORIES',
    kind: 'test-only',
    premise:
      '「会上墨的 category」的 SSOT，从 ATTENTION_URGENCY 里 urgent 的键派生。生产侧三处 rollup' +
      '（row-attention / fanout-group / attentionAccentFor）问的都是单个 category 紧不紧急，走类型守卫' +
      'isUrgentAttention，不需要这份清单——它们此前各自手抄 `!== \'done\'`，af52fef9 收敛掉的正是那个。' +
      '清单本身留给结构守卫：topic-agent-status.test.ts 与 board-run-card.test.ts 遍历它逐个驱动，' +
      '删了这个导出，那两道守卫就只能手抄两个名字，Core 加一个会上色的 category 时它们静默漏测。'
  },
  {
    module: 'lib/attention-vocabulary.ts',
    name: 'AGENT_DISPLAY_STATES',
    kind: 'test-only',
    premise:
      '全部 Agent 显示状态的 SSOT，从 NEEDS_YOU_BY_STATE 的键派生。八个测试用它逐状态驱动用例，' +
      '不手抄状态清单——手抄正是「新状态恰好在它新增时漏测」的入口。删了它，那些穷举测试就失去全集。'
  },
  {
    module: 'lib/browser-toolbar.ts',
    name: 'withBrowserToolbarItem',
    kind: 'test-only',
    premise:
      '纯 helper：返回把一个工具栏项设成某可见性后的新 AppConfig。生产侧 SurfaceToolDock 用行内 draft' +
      '（`{...current, [item]: shown}`）改，只有 browser-toolbar.test.tsx 用它一次性把每项都关掉来搭 fixture。' +
      '是「为可测性抽出的纯函数」，不是未接线的承诺。'
  },
  {
    module: 'lib/create-pr-intent.ts',
    name: 'intentAllowsCreate',
    kind: 'test-only',
    premise:
      '纯谓词：verdict 允不允许落地 create。生产侧 store 走 `verdict.kind === \'conflict\'` 早退（它要的是' +
      'reason 文案，不是布尔），所以只有 create-pr-intent.test.ts 直接调这个谓词。留着它给那道判据用，' +
      '删了它测试就只能自己手抄「哪些 kind 允许」，与 evaluateCreatePrIntent 漂开。'
  },
  {
    module: 'lib/ime-composition-keyboard-event.ts',
    name: 'resolveImeModifierGesture',
    kind: 'unwired',
    premise:
      '无生产 call site：它是从参考实现复制过来的第四个导出（修饰键手势的 carry 判定），本仓的接入点' +
      '（TerminalView 一族）由别的 agent 持有、暂时接不上。ime-composition-keyboard-event.test.ts 只钉住它' +
      '不是恒定返回，以免它被顺手改坏而无人察觉。是未接线，不是该私有。'
  },
  {
    module: 'lib/ime-composition-keyboard-event.ts',
    name: 'useImeEnterGestureOwnership',
    kind: 'unwired',
    premise:
      '无生产 call site：两次-keydown 的 Enter carry 手势钩子。生产侧四个输入用的是更薄的' +
      'isImeCompositionKeyDown，这个更完整的钩子的接入点尚未落地。测试用 SSR 探针把它的闭包捕获出来驱动，' +
      '守住它的行为直到接线补上。是未接线，不是该私有。'
  },
  {
    module: 'lib/session-state.ts',
    name: 'reduceRuntimeEvent',
    kind: 'test-only',
    premise:
      '薄包装：`projectRuntimeEvent(...).state`，只丢掉那半 effect 通道。生产侧 store 直接调' +
      'projectRuntimeEvent（它要 effect），三个 reducer 测试用这个只关心 state 的包装免去每次解包。' +
      '是「为可测性保留的纯投影」，不是未接线的承诺。'
  },
  {
    module: 'lib/session-visibility.ts',
    name: 'sessionVisibility',
    kind: 'test-only',
    premise:
      '纯工厂：把 windowFocused + 可见集合合成 `(sessionId) => AttentionVisibility`。生产侧 attention-notifier' +
      '在 reconcile 里行内构造同一形状（它自己管 previousStates 生命周期），只有 session-visibility.test.ts' +
      '直接调这个工厂钉住「窗口焦点与在屏与否两轴独立」。是为可测性抽出的纯函数。'
  },
  {
    module: 'lib/shortcut-registry.ts',
    name: 'INNER_SCOPES',
    kind: 'test-only',
    premise:
      '「window 之外的作用域」SSOT，从 SHORTCUT_SCOPES 减一项派生。shortcut-registry.test.ts 的跨作用域' +
      '冲突守卫遍历它——此前它在测试里被手抄成 `terminal || editor`，于是新增作用域被静默排除在守卫外。' +
      '删了这个导出，那道守卫又回到手抄清单的盲点。'
  },
  {
    module: 'lib/terminal-cold-parking-policy.ts',
    name: 'haveSameTerminalRegionIds',
    kind: 'test-only',
    premise:
      '纯集合相等谓词（两个 region-id 集合是否一致）。生产侧 coordinator 用 ref 增量维护可见集、不做整集' +
      '比较，只有 terminal-cold-parking-policy.test.ts 直接调它。是为可测性抽出的纯 helper。'
  },
  {
    module: 'lib/terminal-selection-mode.ts',
    name: 'MOUSE_TRACKING_MODES',
    kind: 'test-only',
    premise:
      '全部鼠标上报模式的 SSOT，从 MOUSE_REPORTING_ACTIVE 的键派生（后者由 xterm 的类型约束覆盖全集）。' +
      'terminal-selection-mode.test.ts 遍历它逐模式质询；此前测试里手抄的 ACTIVE_MODES 漏一个字面量是静默的。' +
      '删了这个导出，逐模式测试就失去全集。'
  },
  {
    module: 'lib/workbench-surface-kinds.ts',
    name: 'WORKBENCH_SURFACE_KINDS',
    kind: 'test-only',
    premise:
      '全部 Workbench surface 种类的 SSOT 元组（两条类型层 exactness 证明钉住它 = 联合）。' +
      'workbench-surface-kind-failure-modes.test.ts 遍历它逐种类驱动，于是第六种被加进联合时自动进测试。' +
      '生产侧的分类器（isSessionSurface 等）走 switch 消费联合本身，不遍历这个元组。删了它，那些穷举测试失全集。'
  },
  {
    module: 'lib/xterm-bypass-policy.ts',
    name: 'shouldSuppressTerminalModifierKeyboardEvent',
    kind: 'unwired',
    premise:
      '无生产 call site：吞掉陈旧 kitty 上报把独立修饰键编成 CSI-u 的那些事件，参考实现在中断处理之前用它。' +
      '本仓 TerminalView 由别的 agent 持有、接不进这条，接线待那侧可动时补。xterm-bypass-policy.test.ts' +
      '守住它的行为。是未接线，不是该私有。'
  }
]

/**
 * 这张豁免表**恰好**这么多条。
 *
 * 钉死一个字面量，不是设一个「≥N」的地板——本仓记过 count-floor-is-not-closedness：地板只在树里恰好没
 * 余量时才开火，买到的是运气而非封闭性，还随代码库长大静默失效。加一条豁免必须同时改这个数字，于是每次
 * 增减都在 review 里显形；下面「每条豁免逐条有效」的自检杀「同数换条」那一侧，两条合起来才封住这张表。
 */
const DELIBERATE_COUNT = 15

const exemptionKey = (module: string, name: string): string => `${module}#${name}`
const EXEMPT = new Set(DELIBERATE.map((entry) => exemptionKey(entry.module, entry.name)))

/**
 * 不动点本体：给定一份 AST 与「哪些导出算种子」，返回没有任何消费者的导出名。
 *
 * 与 `scanSurface` 分开，是为了让判据能跑在**合成模块**上（自检 3）——真实源码里
 * 「只被同文件私有 helper 消费的导出」今天一个都没有，不合成就没有任何东西能让闭包的
 * 「不分导出」那一条变得可观测。
 */
function unconsumedExportsOf(sourceFile: ts.SourceFile, isSeed: (name: string) => boolean): string[] {
  const statements = [...sourceFile.statements]
  const exported = new Set(statements.flatMap(exportedNames))
  if (exported.size === 0) return []

  const alive = new Set([...exported].filter(isSeed))
  // 同文件组合的闭包：迭代到不动点。`alive` 里放的是**任何**已活名字（含非导出的本地 helper），
  // 所以「私有 helper 消费了某个导出」这条边传得过去。
  for (let grew = true; grew; ) {
    grew = false
    for (const statement of statements) {
      if (!declaredNames(statement).some((name) => alive.has(name))) continue
      for (const identifier of identifiersIn(statement)) {
        if (!alive.has(identifier)) {
          alive.add(identifier)
          grew = true
        }
      }
    }
  }
  return [...exported].filter((name) => !alive.has(name))
}

describe('renderer lib 的每个导出都有生产消费者', () => {
  it('没有任何导出是「生产代码不用」的（只被测试用的必须进 DELIBERATE 豁免表）', () => {
    const orphans = real.orphans().map((entry) => entry.replace(`${RENDERER_SRC}/`, ''))
    const unexplained = orphans.filter((entry) => {
      const [file, name] = entry.split(' ')
      return !EXEMPT.has(exemptionKey(file!, name!))
    })
    // 报出 file + 名字而不是只给个数：孤儿要一眼看得到是哪个。
    expect(
      unexplained,
      '这些导出在整棵 renderer**生产**源码里都没有消费者（只被测试引用也算没有）。\n' +
        '三条出路：接线（给它一个真生产消费者）、删掉它与它的测试、\n' +
        '或者进 DELIBERATE 豁免表——**但必须写清可断言的 premise**，死承诺就得如实写「未接线」，\n' +
        '不许伪装成已交付（本仓记过 promised-accessor-never-landed）。\n' +
        `实测：\n${unexplained.join('\n')}`
    ).toEqual([])
  })

  it('自检：扫描面非空且只含生产代码、闭包不是恒真、不存在的名字计零', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：扫描根写错、后缀过滤写错、导出提取返回空，
    // 任何一种都让 orphans 恒为空数组，而「没扫到」与「扫过了没问题」打印出来一模一样。
    expect(real.libFiles.length, 'lib 一个文件都没扫到，扫描根坏了').toBeGreaterThan(100)
    expect(real.consumerFiles.length, '消费者面一个文件都没扫到').toBeGreaterThan(200)

    // 消费面必须**只含生产代码**：一旦有人把 test/ 折回消费面，「只被测试引用」又会算成有消费者，
    // 这道门就退回到放过 rosterBadgeCount 的那一版。逐条核对没有任何消费者落在 test/ 树下，
    // 并且真的含 lib 文件（扫描面确实触到了受判的那批模块，而不是扫了个空目录恒绿）。
    const testRoot = `${TEST_DIR}`
    const consumersInTest = real.consumerFiles.filter((file) => file.startsWith(testRoot))
    expect(consumersInTest, 'test/ 被折进了消费面——「只被测试引用」会被误算成有消费者').toEqual([])
    expect(
      real.consumerFiles.some((file) => file.startsWith(`${LIB_DIR}/`)),
      '消费面里一个 lib 文件都没有——lib 互引也是消费者，缺了它扫描面没真正触到受判模块'
    ).toBe(true)

    // 提取器真的认得出导出：随便挑一个文件都该有导出，且总量得是个大数。
    const totalExports = real.libFiles.reduce(
      (sum, file) => sum + new Set(readAndParse(file).sourceFile.statements.flatMap(exportedNames)).size,
      0
    )
    expect(totalExports, '导出提取器一个名字都没认出来').toBeGreaterThan(500)

    // 不存在的名字必须计零。这条钉住 mentionedOutside 不是恒返回 true——恒真会让上面那条
    // 断言变成「永远没有孤儿」，也就是这道门最危险的假绿形态。
    expect(real.mentionedOutside('zzzNoSuchExportNameEverAppearsHere', LIB_DIR)).toBe(false)

    // 反向：一个**真的**被生产代码消费的导出不许被判成孤儿。挑 clipboard-copy 的出口，它有 9 个
    // 组件在调（见 clipboard-copy.test.ts 那张表），是本仓生产消费面最宽的导出之一。
    expect(real.unconsumedExports(`${LIB_DIR}/clipboard-copy.ts`)).not.toContain('copyTextToClipboard')
  })

  it('自检：闭包只传「同文件」，不会把跨文件的孤儿也判活', () => {
    // 闭包是这道门唯一的宽判来源：它按语句粒度传播，所以一条语句里同时提到「活的」与「死的」
    // 名字时会一起判活。这条断言钉住它至少没有宽到跨文件——否则只要仓里任何地方还有一个活
    // 导出，全仓导出都会被判活，门就彻底失效了。
    //
    // 探针必须同时满足三条，否则这条自检会恒真：
    //   1. **它得还是导出的**——`unconsumedExports` 只返回导出名，拿一个私有常量当探针，
    //      `not.toContain` 永远成立。本文件第一版正是这么写的（用 tab-drop-zone 里那个已被降级为
    //      私有的常量），删掉闭包时它照旧绿，只有上面第一条红。写在这里免得重犯。
    //   2. 它在**别的**文件里一次都没出现——否则它是种子，活是种子给的，与闭包无关；
    //   3. 它确实被判活——说明闭包在工作。
    // `TabDropZone` 三条全中：它只在同文件的 `Exclude<TabDropZone, 'center'>` 里被点名，而那是
    // `resolvePaneColumnEdgeZone` 返回类型的一部分，每个调用方都靠推断消费它。
    const PROBE = 'TabDropZone'
    const probeFile = `${LIB_DIR}/tab-drop-zone.ts`
    expect(
      [...readAndParse(probeFile).sourceFile.statements.flatMap(exportedNames)],
      `探针 ${PROBE} 必须是导出的，否则 unconsumedExports 永远不会返回它，这条自检恒真`
    ).toContain(PROBE)
    expect(real.mentionedOutside(PROBE, probeFile), `探针 ${PROBE} 在别的文件里出现了，它是种子而非闭包救活的`).toBe(false)
    expect(real.unconsumedExports(probeFile)).not.toContain(PROBE)
  })

  it('自检：豁免表条数被钉死——加一条 / 删一条都必须改这个数字', () => {
    // 这是这张表**封闭性**的那一半（另一半是下面「每条都仍然名副其实」）。钉死一个字面量而不是设
    // 「≥N」的地板：本仓记过 count-floor-is-not-closedness——地板只在树里恰好没余量时才开火，买到的是
    // 运气不是性质，还随代码库长大静默失效。写死这个数，剥掉某个真守卫 + 自己往表里塞一条豁免这种
    // 「同数换条」以外的偷渡（悄悄多加一条）就当场变红，逼它在 review 里显形。
    expect(
      DELIBERATE.length,
      '豁免表条数变了。加/删豁免必须同步改 DELIBERATE_COUNT——这不是地板而是封闭性判据，' +
        '别把它改大来让新豁免悄悄过关。'
    ).toBe(DELIBERATE_COUNT)
    // 键唯一：同一个 (module, name) 写两条会让 EXEMPT 的 Set 把它去重，条数对不上也就罢了，更坏的是
    // 一条失效的豁免被另一条同键的掩盖。
    expect(EXEMPT.size, '豁免表里有重复的 (module, name)').toBe(DELIBERATE.length)
  })

  it('自检：每条豁免都仍然名副其实——指向真导出、仍是生产孤儿、且确有测试消费者', () => {
    // 这是封闭性的另一半，杀「同数换条」：把一条真豁免换成一条虚构/失效的豁免，条数不变，只有这里红。
    // 逐条质询三件事，任何一件不成立，这条豁免就不再守着它声称守的东西：
    //   1. premise 里的名字仍是那个 lib 文件的真实导出（重命名/删除后表会指向虚构，虚构的豁免永不匹配、
    //      白占一个名额，本仓记过 promised-accessor-never-landed 那类「注释举的例子早已不存在」）；
    //   2. 它在**生产**面上仍是孤儿——一旦接上真生产消费者，豁免就该删掉，否则表只增不减变成允许清单
    //      （forbidden-list-guard-always-leaks 的另一半）；
    //   3. 它在 test/ 里**确有**消费者——否则它是零消费者的死代码，该删，不该借豁免续命。
    //      这一步需要一个含 test/ 的消费面，只在这里为自检而建（主判据的消费面刻意不含 test/）。
    const testConsumers = sourceFilesUnder(TEST_DIR)
    const identifiersByTestFile = testConsumers.map((file) => identifiersIn(readAndParse(file).sourceFile))
    const referencedInTests = (name: string): boolean =>
      identifiersByTestFile.some((identifiers) => identifiers.has(name))
    const productionOrphans = new Set(real.orphans().map((entry) => entry.replace(`${RENDERER_SRC}/`, '')))

    const stale: string[] = []
    const noLongerOrphan: string[] = []
    const notTestConsumed: string[] = []
    for (const entry of DELIBERATE) {
      const modulePath = `${RENDERER_SRC}/${entry.module}`
      const exported = new Set(readAndParse(modulePath).sourceFile.statements.flatMap(exportedNames))
      if (!exported.has(entry.name)) stale.push(exemptionKey(entry.module, entry.name))
      if (!productionOrphans.has(`${entry.module} ${entry.name}`)) noLongerOrphan.push(exemptionKey(entry.module, entry.name))
      if (!referencedInTests(entry.name)) notTestConsumed.push(exemptionKey(entry.module, entry.name))
      expect(entry.premise.length, `${entry.name} 的豁免 premise 太短，写不出一句能被质询的话`).toBeGreaterThan(40)
    }
    expect(stale, '这些豁免指向不存在的导出——重命名或删除之后表没跟上').toEqual([])
    expect(
      noLongerOrphan,
      '这些豁免现在有生产消费者了（或者已删除），不再是孤儿。把它们从 DELIBERATE 里删掉，' +
        '别让豁免表变成只增不减的允许清单'
    ).toEqual([])
    expect(
      notTestConsumed,
      '这些豁免在 test/ 里也没有消费者——它们是零消费者的死代码，该删，不该借豁免续命'
    ).toEqual([])
  })

  it('自检：闭包传递「非导出」声明——今天没有真实见证，所以用合成模块钉住', () => {
    // 本文件有两条不读真实源码的断言（这条与自检 4），各自的理由必须写清：
    //
    // 闭包刻意「不分那条声明有没有 export」（`declaredNames` 而不是 `exportedNames`），为的是让
    // 「导出只被同文件的**私有** helper 消费」这条边传得过去。而**本仓今天没有任何这种形状**——
    // 实测把闭包收窄成只走导出声明，整棵树的裁决一字不变（两种写法都是 0 个孤儿，差集为空）。
    // 于是那一条收窄在真实源码上**完全不可观测**：把 `declaredNames` 换成 `exportedNames`
    // 整套测试照旧全绿。本仓记过这一族（「守卫要判可达性不是在场」「结构守卫对整体 no-op 免疫」）：
    // 判据必须**被证明会红**，不能假定它守着。
    //
    // 合成模块提供那个缺席的见证：`kept` 只被私有的 `helper()` 引用，`helper` 自己被导出的
    // `entry()` 引用，`entry` 是种子。少了「不分导出」这一跳，`helper` 传不出去，`kept` 会被
    // 误报成孤儿。合成的代价是它不证明真实源码里有这种形状（今天没有），只证明**判据本身**
    // 认得它——所以上面那条全树断言才是主判据，这条只守着它的一个能力。
    const synthetic = parseTsx(
      'synthetic-closure-witness.ts',
      [
        'export const kept = 1',
        'function helper(): number { return kept }',
        'export function entry(): number { return helper() }'
      ].join('\n')
    )
    const seeds = new Set(['entry'])

    expect(
      unconsumedExportsOf(synthetic, (name) => seeds.has(name)),
      '闭包没能穿过非导出的 helper：`kept` 被误报成孤儿。这正是 declaredNames→exportedNames 那次收窄的后果'
    ).toEqual([])

    // 反向自检：这个合成模块**真的**依赖那一跳，否则上面那条恒真。只走导出声明时 `kept` 必须掉出来。
    const exportedOnly = (sourceFile: ts.SourceFile): string[] => {
      const statements = [...sourceFile.statements]
      const exported = new Set(statements.flatMap(exportedNames))
      const alive = new Set([...exported].filter((name) => seeds.has(name)))
      for (let grew = true; grew; ) {
        grew = false
        for (const statement of statements) {
          if (!exportedNames(statement).some((name) => alive.has(name))) continue
          for (const identifier of identifiersIn(statement)) {
            if (!alive.has(identifier)) {
              alive.add(identifier)
              grew = true
            }
          }
        }
      }
      return [...exported].filter((name) => !alive.has(name))
    }
    expect(
      exportedOnly(synthetic),
      '合成模块没能区分两种闭包，上面那条断言因此恒真——换一个真的依赖私有 helper 的形状'
    ).toEqual(['kept'])
  })

  it('自检：非空见证——整条判据跑在一棵合成目录树上，孤儿必须被报出来', () => {
    // 真实树上今天 **0 个孤儿**，于是上面那条主判据是 `toEqual([])`——**一个恒返回 `[]` 的实现同样
    // 满足它**。#624 实测：把 `unconsumedExportsOf` 首行改成 `return []`，本文件 4 条全绿；整道门
    // 那一刻退化成一个常量。前三条自检也拦不住——它们判的是扫描面规模、`mentionedOutside` 不恒真、
    // 以及两个 `not.toContain`（恒空数组天然满足）。「答案在真实输入上恒为空」的守卫就是常量，
    // 这是本仓记过的一族。
    //
    // 这条断言提供那个缺席的**非空**见证：写一棵最小的合成目录树，让 `scanSurface` 整体跑在它上面，
    // 断言孤儿一字不差地被报出来。落在**目录树**而不是单个 AST 上是刻意的——本仓记过「抽进 lib 只
    // 解决一半」：内容判据抽出来变可测之后，外面那层壳照旧没人守。这里那层壳是 `orphans()`：遍历
    // libFiles、逐个调 `unconsumedExports`、把结果拼成 `<file> <name>`。两个 lib 文件**各带一个**
    // 孤儿，于是「只扫了第一个文件就返回」也会红；断言比对整条格式化后的字符串，于是「只报名字、
    // 丢了文件」也会红。
    const dir = mkdtempSync(join(tmpdir(), 'amux-orphan-witness-'))
    try {
      const write = (name: string, lines: string[]): string => {
        const path = join(dir, name)
        writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
        return path
      }
      const alpha = write('alpha.ts', ['export const alphaKept = 1', 'export const alphaOrphan = 2'])
      const beta = write('beta.ts', ['export const betaOrphan = 3'])
      const consumer = write('consumer.ts', [
        "import { alphaKept } from './alpha.js'",
        'export const total = alphaKept + 1'
      ])
      // 消费者面**含两个 lib 文件本身**，照着真实面的形状来：`lib/` 就在 renderer/src 底下，所以
      // 一个 lib 文件引用另一个 lib 文件的导出也算消费者（`mentionedOutside` 只排除定义文件自己）。
      const synthetic = scanSurface([alpha, beta], [alpha, beta, consumer])

      // 判据是**完整清单**而不是「至少含某个」：被消费的 `alphaKept` 必须不在里面，所以「把所有导出
      // 都报出来」这种反向坍缩同样会红。不为它另写一条 `not.toContain`——同一个 it 里两条断言判同一个
      // 返回值时，先抛的那条让后面成死代码（本仓记过 two-throws-in-one-it-mask-each-other），而这里
      // 无论多报还是少报都先撞上这一条。
      expect(
        synthetic.orphans().map((entry) => entry.replace(`${dir}/`, '')).sort(),
        '合成树上的孤儿没被完整报出来：要么 unconsumedExportsOf 恒空，要么 orphans() 那层壳漏了文件或漏了拼接'
      ).toEqual(['alpha.ts alphaOrphan', 'beta.ts betaOrphan'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
