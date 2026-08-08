import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { GH_UNAVAILABLE, GIT_UNAVAILABLE } from '../src/renderer/src/lib/git-bridge.js'

/**
 * 守的缺陷（#364 / #365）：「preload 桥在不在」这一个判断在渲染层被独立手抄了四次，三种写法。
 *
 * - `store.ts` 与 `useGitStatus.ts`：`window.agentmux?.git` 加判缺席，并各自**又抄了一遍**同一句
 *   'Git is unavailable in this build.'。
 * - `ChangesPanel.tsx` 两处：`window.agentmux!.git`，非空断言。桥缺席时点 Stage / Commit 抛裸
 *   `TypeError`，而**同一屏上** `useGitStatus` 对**同一个桥**好好地报了「不可用」。同一个前提被判出
 *   两种结论，一处说「这个 build 里没有 git」，一处直接崩——这就是手抄的代价。
 *
 * 为什么这一族没有类型层的强制力：git / gh 刻意只活在 `AgentMuxPreloadApi` 上而**不在**共享的
 * `AgentMuxDesktopApi` 上（contracts.ts:900-932 写明了理由：web preview 没有有意义的 git mock）。
 * 于是渲染层拿桥的唯一途径就是摸 `window`，而摸 `window` 这件事 `tsc` 永远不会反对。这是刻意的设计，
 * 不是疏漏；代价就是没有任何东西把调用点推向同一个取值口。**这条守卫就是那个缺失的强制力。**
 *
 * 判据：`src/renderer/` 里读 `agentmux` 这个属性的地方，只允许是下面 {@link ALLOWED} 那两个。
 *
 * 这条守卫的全部强制力都压在 `agentmuxReads` 认全「读 `agentmux`」的**每一种拼法**上。这一点此前
 * 被高估了：早先的注释写着「一旦没人摸 window，拿桥的唯一出口就是 gitBridge()/ghBridge() 返回的带
 * 标签联合，`tsc` 会拦住非空断言绕过缺席判断这条老路」——这话对**收窄**那一步成立，但它**不**封
 * 「换个拼法再摸一次 window」。`tsc` 对 `window['agent' + 'mux'].git`、`const { agentmux } = window`
 * 一样沉默：这些都是合法的属性读取，类型完全正确。review agent 实测正是用拼接下标与解构各重新手抄
 * 一份桥取值，整族守卫 6 条全绿。所以「tsc 关掉了这个 bypass」是**假的**——关掉它的必须是这条守卫
 * 自己把读取的每种拼法都认全（记忆 counting-a-symbol-misses-other-spellings）。
 *
 * 于是 `agentmuxScan` 枚举读 `agentmux` 的所有静态可判写法：点号访问、字符串下标、静态可折叠的拼接
 * 下标（`['agent' + 'mux']`）、（重命名）解构。而**从全局对象上静态判不出键名**的动态读取
 * （`window[k]`、`globalThis` 的计算解构键）无法确定读的是不是 agentmux——它们不被静默当成「不是」，
 * 而是收集成 unclassified 由 `没有归类不了的动态取值` 响亮失败并指名（记忆
 * forbidden-list-guard-always-leaks：禁止清单总会漏，能反过来就只认一小撮已识别形状、其余显式失败）。
 * unclassified 只盯**全局对象**（window/globalThis/self）上的动态键：本地对象的 `table[verb]` 这类
 * 查表与桥无关，若也拖进来就会对满仓合法查表发假红。
 *
 * 判据落在 **AST** 上而不是文本上，这一点是承重的：`useGitStatus.ts`、`ChangesPanel.tsx`、
 * `store.ts` 的文档注释里都**正当地**写着 `window.agentmux.git` 这串字（在讲这个桥是什么）。
 * 一个 `readFileSync().toContain()` 形状的守卫会对这几处发假红，而假红久了必被加豁免、豁免再吃掉
 * 真缺陷（记忆 lexical-boundaries-need-a-real-lexer：注释边界要用语言自己的词法器判，别按行猜）。
 * 下面 `注释里提到不算读取` 那一条把这个区分本身做成了断言。
 *
 * ---
 * 本轮（#723）补的第三、四种拼法，以及一处把自己说错了的盲点记录。
 *
 * 【补的盲点】**赋值式解构**与 `Reflect.get`。上面那段说「解构」已经收了，但收的只是**声明式**
 * 解构（`const { agentmux } = window`，AST 上是 BindingElement）。`({ agentmux } = window)` 是
 * **赋值**表达式：AST 上根本不是 BindingElement，而是一个 ObjectLiteralExpression 里的
 * ShorthandPropertyAssignment（重命名式 `({ agentmux: bridge } = window)` 则是 PropertyAssignment）。
 * 三条分支一条都不匹配，于是它既不算命中也不算可疑，**静默逃掉**。`Reflect.get(window, 'agentmux')`
 * 同理：它是 CallExpression，不是任何一种属性访问。
 *
 * 存活的变异（本轮实测，现在会红）：
 *   1. 在 `src/renderer/src/components/ChangesPanel.tsx` 里重新手抄一份桥取值，写成
 *      `let agentmux; ({ agentmux } = window); await agentmux.git.stage(...)`。
 *      修复前：`preload 桥只有一个取值口` 全绿（reads=0、unclassified=0，探针实测）。
 *      修复后：`渲染层没有别的地方再摸 agentmux` 报出该行。
 *   2. 同处写成 `const bridge = Reflect.get(window, 'agentmux')`。修复前同样零命中。
 *
 * 判「这是解构赋值而不是普通对象字面量」必须落在**父节点关系**上：`{ agentmux: 1 }` 作为一个普通值
 * （`const o = { agentmux: 1 }`、`fn({ agentmux: 1 })`）绝不能算读取，否则这条门会对满仓合法的
 * 对象字面量发假红。所以判据是「这个 ObjectLiteralExpression 是某个 `=` 的左操作数」，
 * 见 {@link isAssignmentTargetObject}，反向自证见独立那条
 * `反向自证：普通对象字面量里的 agentmux 键不是一次桥取值`（记忆 forbidden-list-guard-always-leaks 的另一面：允许清单收窄之后，
 * 必须有人证明它没有把合法形状一起收进来）。
 *
 * 【更正一处写错的盲点】此前这里写着「桥取值经**中间变量**再摸（`const w = window; w.agentmux`）」
 * 是残留盲点。**这是错的**：`agentmuxScan` 的点号分支（下面那句 `node.name.text === 'agentmux'`）
 * 刻意**不判根对象是什么**，所以 `w.agentmux` 照样命中——探针实测 reads=1。把一个其实守住了的
 * 形状记成盲点，会让下一个人以为这里有条现成的绕过路可走，也会让人去"修"一个不存在的缺口
 * （记忆 expired-reason-for-not-mapping：读起来像已决之事的注释，没人会回头验它）。为了让这次更正
 * 不再退化成另一句无人验的散文，它已经作为 `SPELLINGS` 里的一条**用例**存在（「经中间变量的点号
 * 访问」）：哪天点号分支真的开始判根对象，那条会红。
 *
 * 仍在的盲点（这次逐条验过）：
 * - **属性名整个来自运行期值**：`Reflect.get(window, key)`、`window[k]`。判不出它读没读
 *   agentmux，只能标 unclassified 让人回看——保守出口，不是漏。
 * - **跨函数传递**：把 `window` 当实参传进某个 helper，再在 helper 里摸 `.agentmux`。命中的是
 *   helper 里那一次（形参名不重要，因为点号分支不判根对象），所以逃不掉；但如果 helper 收的是
 *   **属性名字符串**再自己拼下标，就落进上一条的 unclassified。
 * - **本文件不做符号解析**：`createSourceFile` 只有词法/语法层，没有 TypeChecker。上面两条的
 *   根因都是这个，要真解析得换 `ts.createProgram`（代价是这条守卫会依赖 tsconfig 的 include，
 *   而 `apps/desktop/tsconfig.json` 恰好**不含** test/，见下）。
 *
 * 【关于 tsc 的担保，再说清一次】文件头前面已经写明「tsc 关掉了这个 bypass 是假的」。补一条更硬的
 * 事实：`apps/desktop/tsconfig.json` 的 `include` 只列了 src 下的 .ts / .tsx 与仓库根的 .ts，
 * **test/ 整个目录都不在里面**。所以本文件里任何"编译期"判据（类型标注、satisfies、Record 键位）
 * 都不会被 `pnpm check` 执行到——本文件的强制力 100% 来自下面这些 `it`，一条都不能靠 tsc 兜。
 */

const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url))

/**
 * 允许摸 `agentmux` 的两个地方，各自的理由。
 *
 * 每条豁免都自带在场自检（见 `每条豁免都真的在用`）：一条指向不存在或已经不再摸 window 的文件的
 * 豁免是死代码，而死豁免会让人以为某处仍被允许（记忆 cleanup-without-a-detector-is-not-cleanup）。
 */
const ALLOWED: Record<string, string> = {
  'src/lib/git-bridge.ts': '收敛层本身——这一层存在的意义就是替所有人摸这一次',
  'src/lib/api.ts': 'requireDesktopApi：把 preload 面包成共享的 api，是另一条正当的单一入口'
}

type Read = { file: string; line: number }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/u.test(entry) ? [full] : []
  })
}

/**
 * 一个文件里所有**读 `agentmux` 属性**的位置，外加所有**归类不了的可疑动态读取**。
 *
 * 刻意不判「根对象是不是 `window`」：`globalThis.agentmux`、`self.agentmux`、
 * `(window as any).agentmux`、`window['agentmux']` 都是同一件事的别的拼法，只钉住 `window.` 那一种
 * 等于给绕过留门（记忆 counting-a-symbol-misses-other-spellings）。所以判据是属性名本身，
 * **取属性的写法都收**：点号访问、下标访问（字符串字面量键，含静态可折叠的 `+` 拼接）、以及解构。
 *
 * 解构那一条是后补的：`const { agentmux } = window` 既不是 PropertyAccess 也不是 ElementAccess，
 * 实测（review agent 复现）用它重新手抄一份桥取值，整族守卫 6 条全绿。判据取 `propertyName ?? name`，
 * 于是重命名解构（`const { agentmux: bridge } = window`）也算在内。
 *
 * 下标里的**拼接**是本轮补的：`window['agent' + 'mux']` 静态折得出 `agentmux`，review agent 实测
 * 用它绕过，6 条全绿。现在把可静态折叠的字符串 `+` 折出来再比属性名。
 *
 * 关键的一半：**折不出静态名字的动态读取要响亮，不能静默放过**（记忆 forbidden-list-guard-always-leaks）。
 * `window[k]`、`window['agent' + suffix]`、`const { [k]: v } = window` 这类静态解析不出键名的写法，
 * 单看无法判断它读的是不是 `agentmux`——但它恰恰是隐藏一次桥取值的天然去处。它们被收集成
 * `unclassified` 一并带出，由 {@link 没有归类不了的动态取值} 那条断言响亮失败并指名。今天 renderer
 * 里一处这种写法都没有（见那条断言的反向自证）。
 */
// 注：`Read` 的定义在上面（`ALLOWED` 之后）。这里此前重复声明了一次同名类型，是真 TS2300
// （`Duplicate identifier 'Read'`，两处各报一条）。tsc 没有喊出来只是因为
// apps/desktop/tsconfig.json 的 include 不含 test/——见文件头最后一段。

// 从字符串字面量或字面量 `+` 拼接里折出静态值；折不出（变量、模板插值）返回 null。
function staticStringKey(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringKey(node.left)
    const right = staticStringKey(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

// 剥掉括号 / `as T` / `!` / 类型断言外壳，露出里面那个表达式。
function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

// 根对象像不像「全局作用域」——`window` / `globalThis` / `self`（含 `(window as any)` 这类外壳）。
// 只有从全局上做**动态键**读取才是「可能藏着一次 agentmux 取值」的可疑形状；一个本地对象上的
// `FAILURE_COPY[verb]` 与桥毫无关系，不该被这条守卫拖进来。
function isGlobalLike(node: ts.Expression | undefined): boolean {
  if (node === undefined) return false
  const inner = unwrap(node)
  return ts.isIdentifier(inner) && (inner.text === 'window' || inner.text === 'globalThis' || inner.text === 'self')
}

/**
 * 这个对象字面量是不是某个赋值的**左**操作数——即 `({ agentmux } = window)` 这种**赋值式解构**。
 *
 * 承重：普通对象字面量（`const o = { agentmux: 1 }`、`fn({ agentmux: 1 })`）**不是**属性读取，
 * 绝不能算命中，否则这条门会对满仓合法代码发假红。区分二者的唯一可靠依据就是父节点：只有
 * 出现在 `=` 左边时，`{ agentmux }` 才是「从右边那个对象上把 agentmux 读出来」。
 */
function isAssignmentTargetObject(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    unwrap(parent.left) === node
  )
}

/**
 * `Reflect.get(obj, key)` 里的那个 key 表达式；不是 Reflect.get 调用则返回 null。
 *
 * 收它的理由：`Reflect.get(window, 'agentmux')` 是一次不带任何属性访问语法的属性读取，三条
 * 语法分支全都看不见它（实测 reads=0、unclassified=0，静默逃掉）。
 */
function reflectGetKey(node: ts.CallExpression): { key: ts.Expression; target: ts.Expression } | null {
  const callee = unwrap(node.expression)
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (callee.name.text !== 'get') return null
  const owner = unwrap(callee.expression)
  if (!ts.isIdentifier(owner) || owner.text !== 'Reflect') return null
  if (node.arguments.length < 2) return null
  return { key: node.arguments[1]!, target: node.arguments[0]! }
}

function agentmuxScanText(text: string, rel: string): { reads: Read[]; unclassified: string[] } {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const reads: Read[] = []
  const unclassified: string[] = []
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      // 点号访问：键是静态标识符，直接比。名字 `agentmux` 足够独特，不必判根对象。
      if (node.name.text === 'agentmux') reads.push({ file: rel, line: lineOf(node) })
    } else if (ts.isElementAccessExpression(node)) {
      // 下标访问：字符串字面量或拼接折出键名（`['agent' + 'mux']`）。
      const key = staticStringKey(node.argumentExpression)
      if (key === 'agentmux') reads.push({ file: rel, line: lineOf(node) })
      // 折不出键名、且根对象是全局：可能正把桥藏在运行期键名里，归为可疑（其余本地对象的动态下标放行）。
      else if (key === null && !ts.isNumericLiteral(node.argumentExpression) && isGlobalLike(node.expression)) {
        unclassified.push(`${rel}:${lineOf(node)}  ${node.getText(source)}`)
      }
    } else if (ts.isBindingElement(node)) {
      // 解构：键取 propertyName ?? name。
      const rawKey = node.propertyName ?? node.name
      const decl = node.parent.parent
      const initGlobal =
        ts.isVariableDeclaration(decl) && decl.initializer !== undefined && isGlobalLike(decl.initializer)
      if (ts.isIdentifier(rawKey) || ts.isStringLiteralLike(rawKey)) {
        if (rawKey.text === 'agentmux') reads.push({ file: rel, line: lineOf(node) })
      } else if (ts.isComputedPropertyName(rawKey)) {
        const resolved = staticStringKey(rawKey.expression)
        if (resolved === 'agentmux') reads.push({ file: rel, line: lineOf(node) })
        // 计算解构键折不出名字、且被解构的是全局：可疑。
        else if (resolved === null && initGlobal) unclassified.push(`${rel}:${lineOf(node)}  ${node.getText(source)}`)
      }
    } else if (ts.isObjectLiteralExpression(node) && isAssignmentTargetObject(node)) {
      // 赋值式解构：`({ agentmux } = window)` / `({ agentmux: bridge } = window)`。这里不是
      // BindingElement（那是声明式解构），而是对象字面量里的 Shorthand/PropertyAssignment。
      for (const property of node.properties) {
        const rawKey = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isPropertyAssignment(property)
            ? property.name
            : undefined
        if (rawKey === undefined) continue
        if (ts.isIdentifier(rawKey) || ts.isStringLiteralLike(rawKey)) {
          if (rawKey.text === 'agentmux') reads.push({ file: rel, line: lineOf(property) })
        } else if (ts.isComputedPropertyName(rawKey)) {
          const resolved = staticStringKey(rawKey.expression)
          if (resolved === 'agentmux') reads.push({ file: rel, line: lineOf(property) })
          // 计算键折不出名字、且赋值右边是全局：可疑。
          else if (resolved === null && isGlobalLike(unwrap((node.parent as ts.BinaryExpression).right))) {
            unclassified.push(`${rel}:${lineOf(property)}  ${property.getText(source)}`)
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      // `Reflect.get(window, 'agentmux')`：一次没有属性访问语法的属性读取。
      const reflect = reflectGetKey(node)
      if (reflect !== null) {
        const key = staticStringKey(reflect.key)
        if (key === 'agentmux') reads.push({ file: rel, line: lineOf(node) })
        // 键折不出名字、且取的是全局：可疑。
        else if (key === null && isGlobalLike(reflect.target)) {
          unclassified.push(`${rel}:${lineOf(node)}  ${node.getText(source)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return { reads, unclassified }
}

function agentmuxScan(file: string): { reads: Read[]; unclassified: string[] } {
  return agentmuxScanText(readFileSync(file, 'utf8'), relative(RENDERER, file))
}

function agentmuxReads(file: string): Read[] {
  return agentmuxScan(file).reads
}

/** 一个文件里所有**字符串字面量**的取值。注释天然不在其中——这正是要的。 */
function stringLiterals(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

const FILES = sourceFiles(RENDERER)
const READS = FILES.flatMap((file) => agentmuxReads(file))
const UNCLASSIFIED = FILES.flatMap((file) => agentmuxScan(file).unclassified)

describe('preload 桥只有一个取值口', () => {
  it('渲染层没有别的地方再摸 agentmux', () => {
    const strays = READS.filter((read) => ALLOWED[read.file] === undefined)
    expect(
      strays.map((read) => `${read.file}:${read.line}`),
      '这里又长出了一处独立的桥取值。桥缺席时它会自己编一套说法（或者干脆用 `!` 断言然后崩）——' +
        '这正是 #364 的形状。改成从 lib/git-bridge 的 gitBridge() / ghBridge() 取。'
    ).toEqual([])
  })

  // 归类不了的动态取值要响亮，不能静默放过（记忆 forbidden-list-guard-always-leaks）。一个
  // 全局上的 `window[k]` 或 `const { [k]: v } = globalThis` 静态判不出键名，正是隐藏一次桥取值的
  // 天然去处（本地对象上的动态下标与桥无关，不在此列）。
  it('没有归类不了的动态取值', () => {
    expect(
      UNCLASSIFIED,
      'renderer 里出现了从全局对象静态解析不出键名的动态取值（`window[变量]`、globalThis 的计算解构键、' +
        '拼了变量的下标）。它可能正把 agentmux 桥藏在运行期键名里。请改成静态可判的写法，或从 lib/git-bridge 取。'
    ).toEqual([])
  })

  // 在场自检：上面那条断言在「一个都没找到」时也会通过。遍历一旦坏掉（改错后缀、走错根目录），
  // 整条守卫就静默变恒真（记忆 false-green-gate-patterns 里「扫描根写错静默变绿」那一条）。
  // 为什么下面拆成四个 it（#742 同族，本轮实测）：这四组断言原先挤在一个 it 里，正向计数排在最前，
  // 两条**反向自证**（合法查表 / 普通对象字面量不许被误报）排在后面。于是任何让正向计数失败的变异
  // 都让反向自证变成死代码——实测「isAssignmentTargetObject 恒 false」与「Reflect.get 分支删掉」两个
  // 不同变异报出的是**同一个用例名**，那正是互相掩盖的判别信号（记忆
  // two-throws-in-one-it-mask-each-other）。拆开后正向与反向各自可观测，改一侧不会顺手瞎掉另一侧。
  it('遍历真的看见了源码和取值点', () => {
    expect(FILES.length, 'renderer 下一个源文件都没扫到——扫描根或后缀写错了').toBeGreaterThan(50)
    expect(READS.length, '一处 agentmux 取值都没找到——AST 判据坏了，上面那条已经恒真').toBeGreaterThan(0)
  })

  // 为什么每种拼法各占一条用例，而不是把九种拼在一个 fixture 里数 `toHaveLength(9)`（本轮实测）：
  // 那个计数比缺陷粗。「isAssignmentTargetObject 恒 false」与「Reflect.get 分支删掉」是两个不同的
  // helper 坏掉，实测却打红**同一对**用例名——因为九种拼法共用一个数，任何一种漏掉都只是「9 变 8」。
  // 门是红的，但它说不出哪种拼法丢了，而这正是要修的时候唯一想知道的事（记忆
  // mutation-must-change-one-thing：粗断言会吃掉细断言的信号）。逐条之后，两个变异各打红自己那几行。
  const SPELLINGS: Array<{ name: string; code: string }> = [
    { name: '点号访问', code: 'window.agentmux' },
    { name: '字符串字面量下标', code: "window['agentmux']" },
    { name: '静态可折叠的拼接下标', code: "window['agent' + 'mux']" },
    { name: '模板字面量下标', code: 'window[`agentmux`]' },
    { name: '声明式解构', code: 'const { agentmux } = window' },
    { name: '声明式解构（重命名）', code: 'const { agentmux: bridge } = window' },
    { name: '赋值式解构（重命名）', code: 'let x; ({ agentmux: x } = window)' },
    { name: '赋值式解构（简写）', code: 'let agentmux; ({ agentmux } = window)' },
    { name: 'Reflect.get', code: "Reflect.get(window, 'agentmux')" },
    // 根对象换成中间变量：点号分支刻意不判根对象，所以这条也该命中。此前文件头把它记成盲点，是错的。
    { name: '经中间变量的点号访问', code: 'const w = window; w.agentmux' }
  ]

  it.each(SPELLINGS)('判据自检：$name 被认成一次桥取值', ({ code }) => {
    const scanned = agentmuxScanText(code, 'probe.tsx')
    expect(scanned.reads, `这种拼法漏了——它就是一条现成的绕过路：${code}`).toHaveLength(1)
    expect(scanned.unclassified, `这种拼法被误标成 unclassified：${code}`).toHaveLength(0)
  })

  // 反向的一半同样逐条：真动态键必须计成 unclassified 而不是命中。合成一个 fixture 数 4 时，
  // 少认一种同样只是「4 变 3」，说不出是哪一种。
  const DYNAMIC_SPELLINGS: Array<{ name: string; code: string }> = [
    { name: '下标', code: 'window[k]' },
    { name: '声明式解构的计算键', code: 'const { [k]: v } = window' },
    { name: '赋值式解构的计算键', code: 'let y; ({ [k]: y } = window)' },
    { name: 'Reflect.get 的运行期键', code: 'Reflect.get(window, k)' }
  ]

  it.each(DYNAMIC_SPELLINGS)('判据自检：$name 的运行期键计为 unclassified', ({ code }) => {
    const scanned = agentmuxScanText(code, 'probe.tsx')
    expect(scanned.reads, `动态键被误当成 agentmux 命中：${code}`).toHaveLength(0)
    expect(scanned.unclassified, `这种动态键没被计成 unclassified，于是静默逃掉：${code}`).toHaveLength(1)
  })

  it('反向自证：本地对象上的动态下标与桥无关，不许被拖进 unclassified', () => {
    // `FAILURE_COPY[verb]` 这类查表满仓都有，误报久了必被加豁免、豁免再吃掉真缺陷——那正是本轮
    // 第一版踩过的坑。
    const localIndex = agentmuxScanText('const x = FAILURE_COPY[verb]; const y = table[a][b]', 'probe.tsx')
    expect(localIndex.unclassified, '本地对象的动态下标被误报成可疑').toHaveLength(0)
  })

  it('反向自证：普通对象字面量里的 agentmux 键不是一次桥取值', () => {
    // 承重（本轮新增）：收赋值式解构时如果只判「对象字面量里有这个键」，这一族合法代码会全部变成
    // 假红。所以这条必须和上面那条命中断言成对存在——现在它们各占一个 it，任一侧瞎掉都会被单独报出。
    const plainLiteral = agentmuxScanText(
      'const o = { agentmux: 1 }; fn({ agentmux: 2 }); return { agentmux: 3 }',
      'probe.tsx'
    )
    expect(plainLiteral.reads, '普通对象字面量被误当成一次桥取值——这条门会对合法代码发假红').toHaveLength(
      0
    )
    expect(plainLiteral.unclassified, '普通对象字面量被误报成可疑').toHaveLength(0)
  })

  it('每条豁免都真的在用', () => {
    // 一条没人再用的豁免要删掉，而不是留着。豁免的前提（「这个文件仍是一个正当的取值口」）必须
    // 自己可被质询，否则清单会慢慢变成一份谁也不敢动的许可名单。
    const used = new Set(READS.map((read) => read.file))
    for (const [file, why] of Object.entries(ALLOWED)) {
      expect(used.has(file), `豁免 ${file}（${why}）已经不摸 agentmux 了——把这条豁免删掉`).toBe(true)
    }
  })

  /**
   * 判据是词法的，不是文本的——把这个区分本身做成断言。
   *
   * 有若干文件的**文档注释**里正当地写着 `window.agentmux.git`（在解释这个桥是什么）。它们必须
   * 贡献零个取值点。这一条同时证明两件事：AST 判据没有退化成 `toContain`，以及那些注释不需要豁免。
   */
  it('注释里提到 window.agentmux 不算读取', () => {
    const mentionsInProse = FILES.filter((file) => {
      if (ALLOWED[relative(RENDERER, file)] !== undefined) return false
      return readFileSync(file, 'utf8').includes('window.agentmux') && agentmuxReads(file).length === 0
    })
    expect(
      mentionsInProse.length,
      '没有任何文件是「注释里提到但代码里不读」——这条自检的前提不在场了，' +
        '它已经不能证明判据是词法的。去找一处这样的注释，或者删掉这条断言。'
    ).toBeGreaterThan(0)
  })
})

describe('桥缺席时那句话也只有一处', () => {
  // 两句话从模块自己的导出取，不在测试里手抄一遍：改措辞不该需要改测试，而手抄一份恰恰是被守的
  // 那个缺陷本身（记忆 expected-value-must-not-derive-from-mutation-target 的反面：这里要守的是
  // 「只有一处」，所以取值必须来自那一处）。
  const messages = { GIT_UNAVAILABLE, GH_UNAVAILABLE }

  it('两句都只作为字面量出现一次，且在收敛层里', () => {
    for (const [name, message] of Object.entries(messages)) {
      const sites = FILES.filter((file) => stringLiterals(file).includes(message))
        .map((file) => relative(RENDERER, file))
      expect(sites, `${name} 被抄了（或者搬走了）。缺席时对用户说什么，只能有一处定义。`)
        .toEqual(['src/lib/git-bridge.ts'])
    }
  })

  it('git 与 gh 缺席不是同一句话', () => {
    // 刻意分开：git 不可用是「这个 build 里看不了改动」，gh 不可用是「开 PR 需要桌面端」——用户的
    // 下一步不同。合成一句会把两个处境说成同一件事。
    // 这条只挡「折成同一个字面量」这一种。两句话是不是真的说了两件不同的事，是人的判断，理由记在
    // git-bridge.ts 的注释里（记忆 near-identical-copy-defeats-distinct-classes：not.toBe 只能证
    // 逐字不等，证不了语义有别）。
    expect(GH_UNAVAILABLE).not.toBe(GIT_UNAVAILABLE)
  })
})
