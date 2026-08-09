/**
 * 「改了分屏树的叶子集合，就必须在这一处断言不变量」——这条接线闸的**机器**，两棵树共用一份。
 *
 * 背景：本仓有两棵分屏树，各有一条无条件 throw 的生产断言判「树的叶子 id 集合 ↔ 记录表的键集合」
 * 逐一相等（`assertRegionInvariant` / `assertGroupInvariant`）。装了断言不等于装上了闸：还得问
 * 「每个真的会动集合的地方，是不是都断言了、断言的是不是正是它刚算出来的那个值、那次断言在不在会
 * 执行的路径上」。region 那一侧为此长出了一整套 AST 判据，并逐轮补掉六个坐实的存活变异
 * （#687/#698/#699/#700/#727/#728）。group 那一侧当时只有行为测试，于是同一族缺陷在它身上完全没人守
 * ——实测在 workbench-layout.ts 里新增一个「摘掉一片叶、忘了删对应记录、也不断言」的 reducer，
 * 六文件 83 条全绿（#778）。
 *
 * 所以这份文件存在的理由是**判据将来只有一份**：A/B 判据、两条禁令、豁免机制都从这里取，谁也别再
 * 手抄一遍（本仓 duplicated-rule-defeats-the-fix / two-resolutions-that-happen-to-agree）。
 *
 * **今天的实情，别读成已完成**：只有 group 侧（`workbench-group-wiring-invariant.test.ts`）在消费这份
 * helper。region 侧仍是它自己那份内联实现——这份 helper 就是从它身上抽出来的，但迁移尚未做，因为那个
 * 文件里每条判据都带着实测的变异计数，迁移必须连同重跑那些变异一起交付，不能继承旧数字。于是**现在
 * 有两份**：在其中一份补盲点而忘了另一份，正是 duplicated-rule-defeats-the-fix 的形状。迁移前请把任何
 * 判据修正同时落到两边。
 *
 * ## 两棵树唯一真正不同的地方：怎么找到「会动集合」的调用点
 *
 * 这不是可以统一掉的表面差异，是两棵树的**结构本身**不同：
 *
 *   - region 那棵树有一层**引擎**（`lib/workbench-view-layout.ts`）：引擎自己在里面调 split-tree 的
 *     原语，外面的 reducer 只调引擎的导出函数。于是「会动集合的调用点」＝「调了引擎里被定性为
 *     changes 的那些导出」，靠一张**导出名分类表**识别（那张表另有一条穷举断言：引擎新增导出必须
 *     在表里回答「它动集合吗」）。
 *   - group 那棵树**没有引擎层**：它的 reducer 直接调 split-tree 的原语，而 split-tree 是**两棵树
 *     共用**的泛型代数。于是不能按「调了哪个函数」识别——`removeLeaf` 两棵树都在调。真正把两棵树
 *     分开的是**叶子取值器实参**（`groupLeafId` / `regionLeafId`）：那是调用方必须自己传进去的东西，
 *     不是我在这里手抄的一份文件清单。手抄文件清单会随着代码搬家静默失效，而取值器实参是代码为了
 *     能编译就必须写对的东西。
 *
 * 因此本文件把「站点识别」做成入参（{@link LeafSetWiringConfig.mutators} 加
 * {@link LeafSetWiringConfig.siteAccepts}），其余全部共用。
 *
 * ## 判据 A / B（两条正交，各自都有只杀自己的变异）
 *
 * - **A（喂对值）**：对每个会动集合的调用点，求它的**流集**——从「初始化式（可传递地）引用了这次
 *   调用**结果**（按 AST 节点标识）」的那个局部声明起步，闭包进「初始化式引用了已收集声明」的声明。
 *   要求包着它的函数里至少有一次 `<assertion>(X)`、X 是裸标识符、且 X 词法解析到的**声明节点**落在
 *   流集内。按**声明身份**而非名字比对是承重的：兄弟分支里同名的局部是不同的声明节点，于是替不了
 *   本站点背书（region 侧 #698 坐实过按名字配对的假绿）。
 * - **B（真的跑）**：先用 A 那把尺滤出「本站点自己的断言」（操作数声明节点落在本站点流集里的那些），
 *   **若**存在这样的断言，其中至少一次必须是某个 Block 里的**直接**表达式语句、其后同块里还有 return、
 *   **且其前**同块里没有无条件 return/throw。若本站点一个 in-flow 断言都没有，B 对该站点 vacuously
 *   通过——那是「值没喂对」，由 A 负责报，B 不重复（#699 修了「只看后面有没有 return」，#727 修了
 *   「把合格断言绑在函数上而不是站点上」）。
 *
 * A 与 B 正交而非蕴含：操作数坏 → A 红、B vacuous 绿；可达性坏 → B 红、A 绿。**两条必须拆成各自
 * 独立的 it**，不能合并——本仓 two-throws-in-one-it-mask-each-other 记过，先抛的那条会把后一条变成
 * 死代码。
 *
 * ## 自陈盲点（与断言真实强度一致，不夸大）
 *
 * - A/B 都按声明身份把合格断言绑到**站点**，但**同一站点**的 in-flow 集内若并列多次断言，A 只要其一
 *   喂对、B 只要其一可达即算过，不要求逐条都合格。这是有意的下限。
 * - B 的可达性只看「同一个 Block 内、这条语句前后的直接语句序列」这一层线性次序，不建模更深的控制流
 *   （早退藏在更外层块、try/catch 语义）。不是完备可达性分析。
 * - 逃逸面：{@link callSites} 只认「callee 是标识符、经具名 import 别名解析后落在 mutators 里」的调用。
 *   `import * as ns` 后 `ns.removeLeaf(...)` 的成员访问、或经二次 re-export 换名的调用点，既逃 callSites
 *   也逃两条禁令。今天 renderer 里没有这两种写法（`import * as` 全部是 radix/monaco），若将来引入需另补
 *   守卫——此处如实点名，不假装已覆盖。
 * - {@link enclosingFunction} 对 class **方法**返回 null：方法体里的调用会因 owner 为 null 而流集空、
 *   asserts 空，A 当场把它算成 unguarded 而**无条件红**。那是响亮假红（要求作者来处理），不是静默逃逸。
 * - **这份 helper 自己被谁调用，helper 管不了。** 把某棵树的 describe 整块删掉，剩下的测试不会红——
 *   删测试文件本身从来不是那个文件能守住的事。两棵树各自的 `REQUIRED_COVERED` 逐名钉住它自己的站点，
 *   外加 {@link exportedLeafAccessors} 让「渲染层里每个导出的叶子取值器都被某棵树认领」可被断言，
 *   于是**新增第三棵树**会红；而删掉已有那一棵靠 code review。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export type LeafSetWiringConfig = {
  /** 渲染层源码根（绝对路径，以 `/` 结尾），扫描面就是它下面的全部 .ts/.tsx。 */
  readonly rendererRoot: string
  /** 这棵树那条无条件 throw 的生产断言的函数名。 */
  readonly assertion: string
  /** 定义 mutators 的模块（渲染层相对路径）。扫描时跳过它自己——否则递归自调会被当成调用点。 */
  readonly definer: string
  /** 规范名落在这里的调用，**可能**会改变叶子 id 集合。 */
  readonly mutators: ReadonlySet<string>
  /**
   * 站点的额外判据：`mutators` 命中之后再问一次「这次调用作业的是**这棵**树吗」。
   * group 侧用它检查叶子取值器实参；region 侧的 mutators 本身就只属于它那棵树，故不需要。
   */
  readonly siteAccepts?: (call: ts.CallExpression) => boolean
}

/** 一次 `<assertion>(...)` 调用的三项事实。 */
export type AssertSite = {
  /** 裸标识符实参词法解析到的**声明节点**（不是裸标识符、或解析不到局部声明则 null）。 */
  readonly operandDecl: ts.VariableDeclaration | null
  /** 仅供诊断消息，判据一律不按名字比对。 */
  readonly operandName: string | null
  /** 块内直接语句、其后有 return、且其前无无条件 return/throw。 */
  readonly runsBeforeReturn: boolean
}

export type MutatorSite = {
  readonly file: string
  readonly fn: string
  readonly mutator: string
  /** 判据 A：本函数里由该调用结果传递派生出的局部**声明节点**（按身份，不按名字）。 */
  readonly flow: readonly ts.VariableDeclaration[]
  /** 判据 A/B：本函数里每次断言的三项事实。 */
  readonly asserts: readonly AssertSite[]
}

export function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(full) && !full.endsWith('.d.ts')) found.push(full)
    }
  }
  walk(root)
  return found.map((full) => full.slice(root.length))
}

export function parse(root: string, relative: string): ts.SourceFile {
  // .tsx 必须按 TSX 解析：扫描面含组件文件（转发禁令要扫全渲染层），按 TS 解析会把 JSX 读成比较运算
  // 而静默丢掉那棵子树里的调用点。
  return ts.createSourceFile(
    relative,
    readFileSync(join(root, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** 包着 `node` 的最近一个具名函数（声明式，或赋给某个变量的箭头/函数表达式）。 */
export function enclosingFunction(node: ts.Node): { name: string; body: ts.Node } | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name) return { name: cursor.name.text, body: cursor }
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return { name: cursor.parent.name.text, body: cursor }
    }
  }
  return null
}

/**
 * 一个源文件里，从 `moduleHint`（渲染层/包内相对路径）或 `@agentmux/layout`（布局代数包）具名 import
 * 出来的「本地名 → 规范名」别名表（无别名则为恒等）。
 *
 * 为什么要认两种来源：布局代数已抽进 `@agentmux/layout`，渲染层的调用点直接从包 import；而包内部的
 * reducer 仍以相对路径（`./split-tree` 等）互相引用。两棵源码树都在扫描面里，故两种说明符都要认。
 */
export function aliasMapFor(file: ts.SourceFile, moduleHint: string): Map<string, string> {
  const map = new Map<string, string>()
  file.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === '@agentmux/layout' ||
        node.moduleSpecifier.text.replace(/^\.\//, '').endsWith(moduleHint)) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        map.set(spec.name.text, (spec.propertyName ?? spec.name).text)
      }
    }
  })
  return map
}

/** 一个标识符引用词法解析到的局部变量声明（按作用域就近，找不到则 null）。用于按**身份**而非名字比对。 */
export function resolveVarDecl(ref: ts.Identifier): ts.VariableDeclaration | null {
  const isScope = (n: ts.Node): boolean =>
    ts.isBlock(n) ||
    ts.isSourceFile(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isForStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isCaseBlock(n)
  const nearestScope = (n: ts.Node): ts.Node | null => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (isScope(c)) return c
    return null
  }
  for (
    let scope: ts.Node | undefined = nearestScope(ref) ?? undefined;
    scope;
    scope = nearestScope(scope) ?? undefined
  ) {
    let hit: ts.VariableDeclaration | null = null
    const scan = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === ref.text &&
        nearestScope(n) === scope
      ) {
        hit = n
      }
      n.forEachChild(scan)
    }
    scan(scope)
    if (hit) return hit
  }
  return null
}

const subtreeHas = (root: ts.Node, target: ts.Node): boolean => {
  let found = false
  const walk = (node: ts.Node): void => {
    if (node === target) found = true
    node.forEachChild(walk)
  }
  walk(root)
  return found
}

/**
 * 判据 A 的「流集」：一个函数体里，把 `anchorCall` 的结果（按节点标识）传递派生出去的全部局部**声明
 * 节点**。用声明节点（不是名字）作元素是承重的——同名兄弟局部是不同节点，不会互相代偿。
 */
export function flowSetFromCall(
  ownerBody: ts.Node,
  anchorCall: ts.CallExpression
): ts.VariableDeclaration[] {
  const decls: ts.VariableDeclaration[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) decls.push(node)
    node.forEachChild(collect)
  }
  collect(ownerBody)
  const flow = new Set<ts.VariableDeclaration>()
  for (const decl of decls) if (decl.initializer && subtreeHas(decl.initializer, anchorCall)) flow.add(decl)
  let changed = true
  while (changed) {
    changed = false
    for (const decl of decls) {
      if (flow.has(decl) || !decl.initializer) continue
      let refs = false
      const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const target = resolveVarDecl(node)
          if (target && flow.has(target)) refs = true
        }
        node.forEachChild(walk)
      }
      walk(decl.initializer)
      if (refs) {
        flow.add(decl)
        changed = true
      }
    }
  }
  return [...flow]
}

/**
 * 一个函数体里每次 `assertion(...)` 调用的三项事实。
 *
 * `flow` 里收的是**声明**节点，而流集只收「有初始化式的 VariableDeclaration」。group 侧的两个
 * reducer 用 `let root = ...` 起头再逐步重赋值（`root = removeLeaf(root, ...)`），那次重赋值是
 * `BinaryExpression`、不是声明，所以按初始化式追踪追不到它——{@link flowSetFromCall} 的入口条件是
 * 「初始化式引用了这次调用」，而 `let root` 的初始化式是 `layout.root`，不含这次调用。
 * 这一族由 `reassignmentFlow` 补齐（见其说明）。
 */
export function assertSitesIn(ownerBody: ts.Node, assertion: string): AssertSite[] {
  const out: AssertSite[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === assertion) {
      const arg = node.arguments[0]
      const operandName = arg && ts.isIdentifier(arg) ? arg.text : null
      const operandDecl = arg && ts.isIdentifier(arg) ? resolveVarDecl(arg) : null
      let runsBeforeReturn = false
      const statement = node.parent
      if (statement && ts.isExpressionStatement(statement) && statement.parent && ts.isBlock(statement.parent)) {
        const statements = statement.parent.statements
        const index = statements.indexOf(statement)
        const precededByExit =
          index >= 0 &&
          statements.slice(0, index).some((stmt) => ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt))
        const followedByReturn =
          index >= 0 && statements.slice(index + 1).some((stmt) => ts.isReturnStatement(stmt))
        runsBeforeReturn = index >= 0 && !precededByExit && followedByReturn
      }
      out.push({ operandDecl, operandName, runsBeforeReturn })
    }
    node.forEachChild(walk)
  }
  walk(ownerBody)
  return out
}

/**
 * 补齐「先 `let x = 原树`、再 `x = mutator(x, …)` 重赋值」这一族的流集。
 *
 * 为什么必须补：{@link flowSetFromCall} 的入口条件是「某个局部声明的**初始化式**引用了这次调用」。
 * group 侧 `moveTab` / `moveTabToNewGroup` 都是 `let root = layout.root` 起头，再在 if 里
 * `root = removeLeaf(root, groupLeafId, sourceGroupId) ?? root`——那次调用坐在赋值表达式里，
 * 谁的初始化式都没引用它，于是流集算成空、判据 A 对这两个站点 vacuously 恒真。**这正是假绿方向**，
 * 不能靠「今天恰好写成 const」赌运气。
 *
 * 修法与 A 同构、仍按声明身份：若这次调用坐在一次对**裸标识符**的赋值里，把那个标识符解析到的声明
 * 节点纳入流集，再让 {@link flowSetFromCall} 的闭包步骤把从它派生的下游一起收进来。
 */
export function reassignmentFlow(anchorCall: ts.CallExpression): ts.VariableDeclaration | null {
  for (let cursor: ts.Node | undefined = anchorCall.parent; cursor; cursor = cursor.parent) {
    if (ts.isBinaryExpression(cursor) && cursor.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return ts.isIdentifier(cursor.left) ? resolveVarDecl(cursor.left) : null
    }
    // 只往上走到语句边界：再往上就不是「这次调用的赋值」了。
    if (ts.isStatement(cursor)) return null
  }
  return null
}

/**
 * 每个「会动集合」的调用点，连同包着它的函数、该函数的流集与它体内每次断言的三项事实。
 * callee 名先经本文件的别名表解析回规范名再查 `mutators`——别名调用点仍留在扫描面。
 */
export function callSites(config: LeafSetWiringConfig): MutatorSite[] {
  const sites: MutatorSite[] = []
  for (const relative of sourceFiles(config.rendererRoot)) {
    if (relative === config.definer) continue
    const file = parse(config.rendererRoot, relative)
    const alias = aliasMapFor(file, moduleHintOf(config.definer))
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const canonical = alias.get(node.expression.text) ?? node.expression.text
        if (config.mutators.has(canonical) && (config.siteAccepts?.(node) ?? true)) {
          const owner = enclosingFunction(node)
          const flow = owner ? flowSetFromCall(owner.body, node) : []
          const reassigned = owner ? reassignmentFlow(node) : null
          // 重赋值那一族：把被赋值的声明并进流集，并把「从它派生的下游声明」也一起收进来——
          // 后者靠再跑一次闭包（以该声明为种子），与 flowSetFromCall 的闭包规则逐字相同。
          const merged = new Set(flow)
          if (reassigned) {
            merged.add(reassigned)
            if (owner) for (const derived of closureFrom(owner.body, merged)) merged.add(derived)
          }
          sites.push({
            file: relative,
            fn: owner?.name ?? '<top-level>',
            mutator: canonical,
            flow: [...merged],
            asserts: owner ? assertSitesIn(owner.body, config.assertion) : []
          })
        }
      }
      node.forEachChild(walk)
    }
    walk(file)
  }
  return sites
}

/** `flowSetFromCall` 闭包步骤的可复用一半：从给定种子出发，收「初始化式引用了种子」的声明。 */
function closureFrom(
  ownerBody: ts.Node,
  seed: ReadonlySet<ts.VariableDeclaration>
): ts.VariableDeclaration[] {
  const decls: ts.VariableDeclaration[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) decls.push(node)
    node.forEachChild(collect)
  }
  collect(ownerBody)
  const flow = new Set(seed)
  let changed = true
  while (changed) {
    changed = false
    for (const decl of decls) {
      if (flow.has(decl) || !decl.initializer) continue
      let refs = false
      const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const target = resolveVarDecl(node)
          if (target && flow.has(target)) refs = true
        }
        node.forEachChild(walk)
      }
      walk(decl.initializer)
      if (refs) {
        flow.add(decl)
        changed = true
      }
    }
  }
  return [...flow].filter((decl) => !seed.has(decl))
}

/** `'lib/split-tree.ts'` → `'split-tree'`：别名表按模块说明符尾部匹配，故只取无扩展名的基名。 */
export function moduleHintOf(definer: string): string {
  return definer.replace(/^.*\//, '').replace(/\.tsx?$/, '')
}

/** 判据 A：本站点没有任何一次断言喂的是「本站点刚算出、准备交出去的那个值」。 */
export function sitesFailingCriterionA(sites: readonly MutatorSite[]): string[] {
  return sites
    .filter((site) => {
      const flow = new Set(site.flow)
      return !site.asserts.some((a) => a.operandDecl !== null && flow.has(a.operandDecl))
    })
    .map(describeSite)
}

/** 判据 B：本站点的 in-flow 断言存在，但没有任何一次落在会执行的路径上。 */
export function sitesFailingCriterionB(sites: readonly MutatorSite[]): string[] {
  return sites
    .filter((site) => {
      const flow = new Set(site.flow)
      const inFlow = site.asserts.filter((a) => a.operandDecl !== null && flow.has(a.operandDecl))
      return inFlow.length > 0 && !inFlow.some((a) => a.runsBeforeReturn)
    })
    .map(describeSite)
}

function describeSite(site: MutatorSite): string {
  return (
    `${site.file}::${site.fn}() 调了 ${site.mutator}；流集(声明节点)=${site.flow.length} 个；` +
    `本站点断言=[${site.asserts
      .map((a) => `${a.operandName ?? '<非标识符>'}${a.runsBeforeReturn ? '·可达' : '·被跳过'}`)
      .join(', ')}]`
  )
}

/**
 * 「渲染层里每个导出的叶子取值器都被某棵树认领了」。
 *
 * 这是防**新增第三棵树**的那道门：再长出一棵分屏树时，它必然要导出自己的叶子取值器（split-tree 的
 * 泛型原语强制调用方传一个），于是这条断言当场红，逼作者回答「这棵树的接线谁守」。
 * 判的是取值器而不是文件清单，因为取值器是代码为了编译就必须写对的东西，文件清单会随搬家静默失效。
 */
export function exportedLeafAccessors(rendererRoot: string): string[] {
  const found: string[] = []
  for (const relative of sourceFiles(rendererRoot)) {
    const file = parse(rendererRoot, relative)
    file.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && /LeafId$/.test(decl.name.text)) found.push(decl.name.text)
      }
    })
  }
  return found.sort()
}
