import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  aliasMapFor,
  callSites,
  exportedLeafAccessors,
  moduleHintOf,
  parse,
  sitesFailingCriterionA,
  sitesFailingCriterionB,
  sourceFiles,
  type LeafSetWiringConfig
} from './helpers/leaf-set-wiring'

/**
 * tab-group 树的接线闸：**共用** region 侧那套 AST 判据（{@link file://./helpers/leaf-set-wiring.ts}），
 * 只把「怎么找到会动集合的调用点」这一件真正不同的事换成本树的判据。
 *
 * 为什么要有这个文件：`assertGroupInvariant`（#567 装的生产断言）判「树的叶子 ↔ layout.groups 逐一
 * 相等」，而 group 侧此前只有行为测试——没有任何东西问「每个真的会动集合的地方都断言了吗」。
 * 实测（#778 的正控）：在 workbench-layout.ts 里加一个
 *
 * @example
 *     export function collapseGroupIntoSibling(layout, groupId) {
 *       return { ...layout, root: removeLeaf(layout.root, groupLeafId, groupId) ?? layout.root }
 *     }
 *
 * @remarks
 * ——摘掉一片叶、不删对应 `groups` 记录、也不断言——六文件 `Tests 83 passed (83)` 全绿。那正是
 * `assertGroupInvariant` 的 JSDoc 说要防的「画不出也关不掉的孤儿 Tab Group」。
 *
 * ## 站点判据：叶子取值器实参，不是文件清单
 *
 * region 那棵树有引擎层（`lib/workbench-view-layout.ts`），故「会动集合的调用点」＝「调了引擎里被定性
 * 为 changes 的导出」。group 这棵树**没有引擎层**：reducer 直接调 `lib/split-tree.ts` 的泛型原语，而
 * 那个模块**两棵树共用**——`removeLeaf` region 侧也在调。
 *
 * 所以本树的判据是**第二个实参是 `groupLeafId`**。三个会改变叶子集合的原语
 * （`removeLeaf` / `replaceLeaf` / `dedupeLeafIds`）签名都是 `(root, leafId, …)`，取值器坐在同一个位置。
 * 选它而不是手抄一份文件清单，理由是：取值器是**代码为了能编译就必须写对**的东西（泛型原语强制调用方
 * 传一个，且 `groupLeafId` 的 Leaf 载荷是 `{ groupId }`，传错树的取值器 tsc 会红），而文件清单会随着
 * 代码搬家静默失效（本仓 forbidden-list-guard-always-leaks / derivation-source-must-be-the-consumed-one）。
 *
 * `collectLeafIds` / `findSiblingLeafId` / `setSplitRatioAtPath` / `clampSplitTreeRatios` **不在** mutators
 * 里：前两个是读，后两个只改 ratio。判据只管「集合会不会多一个或少一个 id」。
 *
 * ## 盲点与假红，逐条如实点名
 *
 * helper 的文件头记了机器共有的那几条（同站点多断言只要其一合格、B 的可达性只看一层线性次序、
 * `import * as` 与 re-export 逃逸、方法体响亮假红）。本文件另有两条自己的：
 *
 *   - **判据只看第二个实参的文本是不是 `groupLeafId`。** 把它经局部 const 转发
 *     （`const acc = groupLeafId; removeLeaf(root, acc, id)`）就逃出站点判据。下方「转发禁令」
 *     堵这个——与 region 侧同一个允许清单机制，且它同时覆盖两棵树的取值器。
 *   - **`removeTab` 第一条出口刻意不断言**，那是它写在 JSDoc 里的容忍（入场时就在的 off-tree group）。
 *     它不在 mutators 站点里，因为那条路径根本不调任何 mutator——不需要豁免条目。
 */
describe('每个改动 tab-group 集合的地方都必须过 assertGroupInvariant 那道闸（#778 接线层）', () => {
  const RENDERER = new URL('../src/renderer/src/', import.meta.url).pathname
  const DEFINER = 'lib/split-tree.ts'
  const ACCESSOR = 'groupLeafId'

  /**
   * split-tree 里会让**叶子 id 集合**多一个或少一个的原语。读与只改 ratio 的不算。
   * 下方有一条穷举断言：split-tree 新增导出必须在这张表里回答「它动集合吗」。
   */
  const PRIMITIVE_EFFECT: Readonly<Record<string, 'changes' | 'preserves'>> = {
    removeLeaf: 'changes',
    replaceLeaf: 'changes',
    dedupeLeafIds: 'changes',
    collectLeafIds: 'preserves',
    findSiblingLeafId: 'preserves',
    leafIdsMatchRecords: 'preserves',
    setSplitRatioAtPath: 'preserves',
    clampSplitTreeRatios: 'preserves',
    clampSplitRatio: 'preserves'
  }

  const MUTATORS = new Set(
    Object.keys(PRIMITIVE_EFFECT).filter((name) => PRIMITIVE_EFFECT[name] === 'changes')
  )

  /** 这次调用作业的是 tab-group 树吗——看它传的叶子取值器。 */
  function usesGroupAccessor(call: ts.CallExpression): boolean {
    const accessor = call.arguments[1]
    return Boolean(accessor && ts.isIdentifier(accessor) && accessor.text === ACCESSOR)
  }

  const CONFIG: LeafSetWiringConfig = {
    rendererRoot: RENDERER,
    assertion: 'assertGroupInvariant',
    definer: DEFINER,
    mutators: MUTATORS,
    siteAccepts: usesGroupAccessor
  }

  // tab-group 的 reducer（removeTab / moveTab / moveTabToNewGroup）与叶子取值器 groupLeafId 已随
  // workbench-layout.ts 抽进 @agentmux/layout，split-tree 原语也在包里。而两个豁免消费者
  // （reconcilePersistedLayout / layoutForActiveTopic）仍在渲染层。于是这道接线闸的扫描面现在横跨
  // 两棵源码树：渲染层 + 包。下面把两棵树各扫一遍再合并——包里的站点文件标签加 `pkg/` 前缀，与渲染层
  // 站点区分开。包里的 definer 是 `split-tree.ts`（相对包 src），扫描时同样跳过它自己。
  const PKG = new URL('../../../packages/layout/src/', import.meta.url).pathname
  const PKG_CONFIG: LeafSetWiringConfig = { ...CONFIG, rendererRoot: PKG, definer: 'split-tree.ts' }

  /** 两棵树合并后的「会动集合」调用点：包里的站点文件标签加 `pkg/` 前缀。 */
  function allSites() {
    return [
      ...callSites(CONFIG),
      ...callSites(PKG_CONFIG).map((site) => ({ ...site, file: `pkg/${site.file}` }))
    ]
  }

  /** 两棵树的叶子取值器。它们逃逸的机制逐字相同，故转发禁令一并扫。 */
  const ACCESSORS = new Set([ACCESSOR, 'regionLeafId'])

  type Occurrence = { file: string; name: string; role: string }

  /**
   * 转发禁令的角色分类器，抽到 describe 作用域，好让下方成对自检**直接质询它**。
   *
   * 抽出来的理由是判据强度，不是整洁：`call-argument` 那条通行证必须连 callee 一起判，而「有没有连
   * callee 一起判」这件事本身需要有人守——否则把它退回只问 `ts.isCallExpression(parent)`，转发禁令
   * 照旧全绿（本仓 extracting-to-lib-only-fixes-half：抽出去只解决一半，壳里那句有没有被执行到照旧
   * 无人守；这里配的是**成对**自检，一条钉「洗白要被认出来」，一条钉「合法站点不许误伤」）。
   */
  function classifyReferencesIn(file: ts.SourceFile): Array<{ name: string; role: string }> {
    // 本文件里「从 DEFINER 具名 import 进来的本地名 → 规范名」。取值器的实参通行证要凭它兑换：
    // callee 必须解析到 DEFINER 的某个导出。用 aliasMapFor（判据 A/B 同一份机器）而不是再手抄
    // 一份解析逻辑，故换名 import（`removeLeaf as rm`）在三处判得一样。
    const alias = aliasMapFor(file, moduleHintOf(DEFINER))
    const calleeIsPrimitive = (call: ts.CallExpression): boolean => {
      if (!ts.isIdentifier(call.expression)) return false
      const canonical = alias.get(call.expression.text)
      return canonical !== undefined && canonical in PRIMITIVE_EFFECT
    }
    const found: Array<{ name: string; role: string }> = []
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const isPrimitive = MUTATORS.has(node.text)
        const isAccessor = ACCESSORS.has(node.text)
        if (isPrimitive || isAccessor) {
          const parent = node.parent
          let role: string
          if (parent && ts.isImportSpecifier(parent)) role = 'import-specifier'
          else if (parent && ts.isCallExpression(parent) && parent.expression === node) role = 'direct-call-callee'
          // 定义处：原语是 `export function removeLeaf(...)`，取值器是 `export const groupLeafId = ...`。
          // 两种都是它自己的声明名，不是转发。
          else if (parent && ts.isFunctionDeclaration(parent) && parent.name === node) role = 'own-declaration'
          else if (parent && ts.isVariableDeclaration(parent) && parent.name === node) role = 'own-declaration'
          // 取值器作为实参被传进 **split-tree 原语**，是它唯一的用法；原语作为实参传出去不是。
          //
          // 这里必须连 callee 一起判。只问「父节点是不是 CallExpression」时，任何一次包裹调用
          // （`removeLeaf(root, wrap(groupLeafId), id)`，或先 `const acc = wrap(groupLeafId)`）
          // 都拿到这张通行证：`usesGroupAccessor` 随后看到的第二个实参是那次 wrap 调用而不是取值器
          // 标识符，于是整个站点从本树的扫描面消失——正是本条禁令要防的那件事。实测（本轮）：加一个
          // 这样的 reducer（丢叶、不删 groups、不断言）时本文件 9 条全绿；连 callee 一起判之后同一个
          // 探针报 `ESCAPE:CallExpression`。判据落在 callee 的**解析目标**上（必须解析到 DEFINER 的
          // 导出），不是 callee 的**文本**——按文本判会被同名影子绕过，那是本仓已经踩过两次的形状
          // （#596 / #670-#671）。
          else if (isAccessor && parent && ts.isCallExpression(parent) && calleeIsPrimitive(parent))
            role = 'call-argument'
          // 原语与取值器都可能出现在 JSDoc / 行内注释引用里——注释不是标识符节点，走不到这里；
          // 但类型位置（如 `typeof groupLeafId`）会，故一并放行。
          else if (parent && ts.isTypeQueryNode(parent)) role = 'type-query'
          else role = `ESCAPE:${parent ? ts.SyntaxKind[parent.kind] : 'no-parent'}`
          found.push({ name: node.text, role })
        }
      }
      node.forEachChild(walk)
    }
    walk(file)
    return found
  }

  /**
   * 刻意不断言的调用点。每条自带**可自证的前提**——一句能被下面前提自检当场推翻的话，
   * 不是「今天没人抱怨」。
   */
  const EXEMPT: ReadonlyArray<{ fn: string; file: string; because: string }> = [
    {
      fn: 'reconcilePersistedLayout',
      file: 'lib/workbench-persistence.ts',
      // 它是这道闸的**修理工**：读回来的持久化 layout 本来就可能违约，职责是把两侧拉回一致。
      // 在它身上断言等于让修理工先证明病人是健康的。而且它跑在持久化路径上（#575 坐实
      // assertGroupInvariant 会在写入路径上抛且用户可达），抛出即那次写入崩。
      // 前提自检：它必须排在 removeTab 之前被两个持久化入口消费，且它自己不抛。
      because: '它是这道闸的修理工，输入必然可能违约，且跑在持久化路径上不许抛'
    },
    {
      fn: 'layoutForActiveTopic',
      file: 'lib/scratch-topic-layout.ts',
      // 它刻意产出一个 `groups` ⊇ 树叶的**超集**：投影到空的分组从树里摘掉，却在 groups 数组里保留
      // （那是存储真相，别的 Topic 的 Tab 还在里面）。断言它必然红，而它是合法的。
      // 前提自检：它的产物不许流回任何 reducer——只能被读取面消费。
      because: '只读投影，刻意产出 groups ⊇ 树叶的合法超集；断言它必红'
    }
  ]

  function coveredSites() {
    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`))
    return allSites().filter((site) => !exempt.has(`${site.file}::${site.fn}`))
  }

  it('split-tree 的每个导出都在分类表里（新增一个必须在这里回答「它动集合吗」）', () => {
    // split-tree 已抽进 @agentmux/layout，读包源码（渲染层那份是 `export *` 薄壳，扫不到函数声明）。
    const file = parse(PKG, 'split-tree.ts')
    const exported: string[] = []
    file.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.push(node.name.text)
      }
    })
    // 在场自检：扫不到导出（改名、改路径、换成 const 导出）会让下面的差集恒空而假绿。
    expect(exported.length, `${DEFINER} 里扫不到任何导出函数——判据的前提不成立`).toBeGreaterThan(5)
    const unclassified = exported.filter((name) => !(name in PRIMITIVE_EFFECT))
    expect(
      unclassified,
      `${DEFINER} 新增了导出 ${JSON.stringify(unclassified)}，但 PRIMITIVE_EFFECT 没给它定性：` +
        '它会不会让一棵树的叶子 id 集合多一个或少一个？会 → changes（调用方必须断言不变量）；不会 → preserves。'
    ).toEqual([])
    // 反向：分类表不许留下已被删掉的名字（否则 changes 那档会静默变空，扫不到任何调用点）。
    const stale = Object.keys(PRIMITIVE_EFFECT).filter((name) => !exported.includes(name))
    expect(stale, `PRIMITIVE_EFFECT 里 ${JSON.stringify(stale)} 已不再是 ${DEFINER} 的导出`).toEqual([])
  })

  it('接线层-A（喂对值）：每个会动集合的调用点，其函数里至少有一次 assertGroupInvariant 断言的正是该调用结果派生出的值', () => {
    const all = allSites()
    // 在场自检 1：扫不到任何 group 侧「会动集合」的调用点（扫描根写错 / 站点判据整体失灵）→ 恒真。
    expect(all.length, '扫不到任何 tab-group 侧「会动集合」的调用点——扫描根或站点判据出了问题').toBeGreaterThan(3)
    const sites = coveredSites()
    // 在场自检 2：流集是本判据的派生集合。若它对每个受管站点都算成空，A 会变成恒红（而不是恒绿），
    // 但为把「流集算法整体失灵」暴露成一条响亮断言而不是藏在别的失败里，这里单独钉一次。
    expect(
      sites.some((site) => site.flow.length > 0),
      '所有受管调用点的流集都算成空了——流集派生失灵，判据 A 失去意义'
    ).toBe(true)
    expect(
      sitesFailingCriterionA(sites),
      '这些函数改了分屏树的 tab-group 集合，但没有任何一次 assertGroupInvariant 断言的是「本函数刚算出来、' +
        '准备交出去的那个值」（即该原语调用结果传递派生出的局部，按声明节点身份判定）。断言喂了别的东西' +
        '（比如入参，或另一个同名但属于别的分支的局部）等于让它对着一个进函数时就已合法的对象空转，' +
        '真正被交出去的新值没人校验——那正是画不出也关不掉的孤儿 Tab Group 的温床。' +
        '修法是在 return 之前 assertGroupInvariant(那个新算出来的 layout)。'
    ).toEqual([])
  })

  it('接线层-B（真的跑）：每个会动集合的调用点，凡有断言了本站点产物的 assertGroupInvariant，其中至少一次必须块内直接、其后有 return（可达）', () => {
    const sites = coveredSites()
    expect(sites.length, '扫不到任何受管的「会动集合」调用点——扫描根或站点判据出了问题').toBeGreaterThan(2)
    // 在场自检：B 用「操作数落在本站点流集」把断言绑到站点。若流集对每个站点都算成空，B 会因
    // 「本站点没有 in-flow 断言」而对所有站点 vacuously 通过、**恒绿**——这正是假绿方向，必须由这条推翻。
    expect(
      sites.some((site) => site.flow.length > 0),
      '所有受管调用点的流集都算成空了——流集派生失灵，判据 B 失去意义（会恒绿）'
    ).toBe(true)
    expect(
      sitesFailingCriterionB(sites),
      '这些函数里断言了「本函数刚算出、准备交出去的那个值」的 assertGroupInvariant，没有任何一次是' +
        '「块内直接语句、其后跟着 return、且其前无无条件退出」的可达形状——它们全被包进了 if / 短路 /' +
        'dev-only 门里，于是在真正把值交出去的那条路径上根本不会执行。纵深断言一旦可被某个构建或某个' +
        '分支跳过就等于没装；另一个分支里可达但断言别的值的断言，代偿不了本站点。' +
        '修法是让 assertGroupInvariant(那个新算出来的 layout) 成为本站点 return 之前的一条无条件语句。'
    ).toEqual([])
  })

  /**
   * 覆盖面按**名字**钉住。裸计数地板（A/B 里的 >3 / >2）只说「至少还有几个站点」，
   * 掉一个仍可能在地板之上——那正是站点静默泄漏的形状。这里逐名要求每个都在。
   */
  const REQUIRED_COVERED: ReadonlyArray<{ file: string; fn: string; mutator: string }> = [
    // reducer 已抽进 @agentmux/layout（`pkg/` 前缀）；两个持久化/投影消费者仍在渲染层。
    { file: 'pkg/workbench-layout.ts', fn: 'removeTab', mutator: 'removeLeaf' },
    { file: 'pkg/workbench-layout.ts', fn: 'moveTab', mutator: 'removeLeaf' },
    { file: 'pkg/workbench-layout.ts', fn: 'moveTabToNewGroup', mutator: 'removeLeaf' },
    { file: 'pkg/workbench-layout.ts', fn: 'moveTabToNewGroup', mutator: 'replaceLeaf' },
    { file: 'lib/workbench-persistence.ts', fn: 'reconcilePersistedLayout', mutator: 'removeLeaf' },
    { file: 'lib/workbench-persistence.ts', fn: 'reconcilePersistedLayout', mutator: 'dedupeLeafIds' },
    { file: 'lib/scratch-topic-layout.ts', fn: 'layoutForActiveTopic', mutator: 'removeLeaf' }
  ]

  it('覆盖面按名字钉住：七个会动 tab-group 集合的调用点必须都在扫描面里（不靠裸计数地板）', () => {
    const seen = new Set(allSites().map((site) => `${site.file}::${site.fn}::${site.mutator}`))
    const missing = REQUIRED_COVERED.filter(
      (want) => !seen.has(`${want.file}::${want.fn}::${want.mutator}`)
    ).map((want) => `${want.file}::${want.fn}() 调 ${want.mutator}`)
    expect(
      missing,
      '这些点名必守的「会动集合」调用点从扫描面消失了（被删/改名/搬走/换了原语/换了取值器）。' +
        '裸计数地板挡不住「掉一个仍在地板之上」，故这里逐名钉死；若确实合法地移除了某个，' +
        '请连同 REQUIRED_COVERED 一起更新。'
    ).toEqual([])
  })

  /**
   * 转发禁令，走**允许清单**而非禁止清单（本仓 forbidden-list-guard-always-leaks：禁止清单被
   * Yoda / 解构 / 下标 / 块外 helper 一一绕过过）。
   *
   * 两个逃逸向量都在这一条里堵掉，因为它们**是同一件事**——把一个值转发出去，让按文本的匹配失明：
   *   1. 原语被转发（`const f = removeLeaf; f(root, groupLeafId, id)`）→ callee 文本变 `f`，
   *      站点整体从 callSites 消失。
   *   2. **取值器**被转发（`const acc = groupLeafId; removeLeaf(root, acc, id)`）→ 第二个实参文本
   *      变 `acc`，`usesGroupAccessor` 判否，站点整体从本树的扫描面消失。
   * 合法引用形状只有两种：作为 import specifier 的名字，或作为一次直接调用的 callee（取值器还多一种：
   * 作为直接调用的**实参**——它本来就是要被传进去的）。其余任何形状带着它的父节点 SyntaxKind 响亮失败。
   *
   * 取值器同时按两棵树扫（`groupLeafId` 与 `regionLeafId`），因为它们逃逸的机制逐字相同，
   * 而这一条是唯一在扫「取值器怎么被引用」的地方。
   */
  it('转发禁令：会动集合的原语与两棵树的叶子取值器都不得被当值转发（否则站点整体逃出扫描面）', () => {
    const occurrences: Occurrence[] = []
    // 两棵源码树都扫：原语与取值器现居 @agentmux/layout，reducer 也在包里；渲染层还留着消费者与薄壳。
    for (const relative of sourceFiles(RENDERER)) {
      const file = parse(RENDERER, relative)
      for (const found of classifyReferencesIn(file)) occurrences.push({ file: relative, ...found })
    }
    for (const relative of sourceFiles(PKG)) {
      const file = parse(PKG, relative)
      for (const found of classifyReferencesIn(file)) occurrences.push({ file: `pkg/${relative}`, ...found })
    }
    const ALLOWED = new Set(['import-specifier', 'direct-call-callee', 'call-argument', 'own-declaration', 'type-query'])
    const escapes = occurrences
      .filter((o) => !ALLOWED.has(o.role))
      .map((o) => `${o.file}: ${o.name} 以 ${o.role} 形状被引用`)
    expect(
      escapes,
      '这些名字被当值转发了（赋给 const、放进容器、当实参传给非调用位置等）。转发会让按文本的站点判据' +
        '整体漏掉真正的调用点——原语被转发时 callee 文本对不上，取值器被转发时第二个实参对不上——' +
        '其函数静默脱离 A/B 覆盖面。请改回直接以规范名调用/传递；若确有不得不转发的正当理由，' +
        '需连同 helper 的解析能力一起扩展，而不是在这里开一个不受守的口子。'
    ).toEqual([])
    // 在场自检：本条扫出的「直接调用 mutator」那一面，其 file::name 集合必须与独立的 callSites
    // 扫描器（它只收 group 树的站点）**包含**关系成立且非空。不用相等是因为本条同时看见 region 树的
    // 原语调用；用非空 + 全含来防「角色分类器整体失灵扫出空集」这种半失灵。
    const primitiveCalls = new Set(
      occurrences.filter((o) => o.role === 'direct-call-callee' && MUTATORS.has(o.name)).map((o) => `${o.file}::${o.name}`)
    )
    expect(primitiveCalls.size, '本条一个「直接调用 mutator」都没扫到——角色分类器或扫描根失灵，本条失去意义').toBeGreaterThan(3)
    const groupSites = new Set(allSites().map((site) => `${site.file}::${site.mutator}`))
    const unseen = [...groupSites].filter((key) => !primitiveCalls.has(key))
    expect(unseen, 'callSites 认得的 group 站点，本条的角色分类器却没认成直接调用——两个扫描器分岔了').toEqual([])
  })

  it('豁免清单不留死条目：EXEMPT 里的每一条都仍在调用某个「会动集合」的原语', () => {
    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`))
    // 用**全部**站点（含被豁免的）核对，否则它会悄悄豁免掉一个将来同名的新函数。
    const live = new Set(allSites().map((site) => `${site.file}::${site.fn}`))
    const dead = [...exempt].filter((key) => !live.has(key))
    expect(dead, `EXEMPT 里 ${JSON.stringify(dead)} 已经不再调用任何「会动集合」的原语`).toEqual([])
  })

  /**
   * 上一条那张 `call-argument` 通行证的**成对**自检，两条各钉一个方向、各有只杀自己的变异。
   *
   * 为什么需要它：转发禁令自己抓不到「通行证发得太宽」。把上面的判据退回只问
   * `ts.isCallExpression(parent)`（不看 callee），禁令对全部 15 个合法站点照旧全绿——而洗白站点
   * 也一起放行。真正区分两个世界的只有下面这对：合成一段被 wrap 洗白过的源码，要求分类器**不**把它
   * 判成 call-argument；再合成一段真正的原语调用，要求它**认下来**。两条都用合成源码而不是扫真文件，
   * 因为真文件里今天恰好没有洗白写法（那正是禁令在保的性质），拿它当输入判据会恒真
   * （本仓 property-unobservable-in-default-env）。
   */
  it('通行证自检（拒）：取值器被包裹调用洗白时，不得拿到 call-argument 通行证', () => {
    const laundered = ts.createSourceFile(
      'zzz-synthetic-launder.ts',
      [
        `import { removeLeaf } from './split-tree'`,
        `import { ${ACCESSOR} } from './workbench-layout'`,
        `const wrap = <T,>(v: T): T => v`,
        `export const drop = (root: never, id: string) => removeLeaf(root, wrap(${ACCESSOR}), id)`
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const accessorRoles = classifyReferencesIn(laundered)
      .filter((found) => found.name === ACCESSOR)
      .map((found) => found.role)
    // 在场自检：这段合成源码里取值器必须真的出现两次（import 一次 + 被洗白那次），否则本条在质询空集。
    expect(accessorRoles.length, '合成源码没被解析出取值器引用——本条在质询空集，判据失效').toBe(2)
    expect(
      accessorRoles.filter((role) => role === 'call-argument'),
      '被 wrap 洗白的取值器拿到了 call-argument 通行证——说明判据退回了「只问父节点是不是 CallExpression」。' +
        '这张通行证必须连 callee 一起判（须解析到 DEFINER 的会动集合导出），否则洗白站点整体逃出扫描面。'
    ).toEqual([])
  })

  it('通行证自检（认）：取值器直接传进 split-tree 原语时，必须拿到 call-argument 通行证', () => {
    const legitimate = ts.createSourceFile(
      'zzz-synthetic-legit.ts',
      [
        `import { removeLeaf as rm } from './split-tree'`,
        `import { ${ACCESSOR} } from './workbench-layout'`,
        `export const drop = (root: never, id: string) => rm(root, ${ACCESSOR}, id)`
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    // 故意用换名 import（`removeLeaf as rm`）：判据落在解析目标上而不是 callee 文本，这一条同时钉住那件事。
    const accessorRoles = classifyReferencesIn(legitimate)
      .filter((found) => found.name === ACCESSOR)
      .map((found) => found.role)
    expect(accessorRoles.length, '合成源码没被解析出取值器引用——本条在质询空集，判据失效').toBe(2)
    expect(
      accessorRoles,
      '合法站点（取值器直接传进 split-tree 原语，且原语是换名 import）没拿到 call-argument 通行证——' +
        '判据收得过窄会对合法代码打假红，或漏掉了别名解析。'
    ).toContain('call-argument')
  })

  it('豁免前提自检 1：reconcilePersistedLayout 被两个持久化入口消费、排在 removeTab 之前、且自己不抛', () => {
    const file = parse(RENDERER, 'lib/workbench-persistence.ts')
    const consumers = new Set<string>()
    let throwsInside = 0
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'reconcilePersistedLayout'
      ) {
        for (let c: ts.Node | undefined = node; c; c = c.parent) {
          if (ts.isFunctionDeclaration(c) && c.name) {
            consumers.add(c.name.text)
            break
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'reconcilePersistedLayout') {
        const countThrows = (inner: ts.Node): void => {
          if (ts.isThrowStatement(inner)) throwsInside += 1
          inner.forEachChild(countThrows)
        }
        countThrows(node)
      }
      node.forEachChild(walk)
    }
    walk(file)
    // 修理工必须真的有人用——否则「它会把两侧拉回一致」这个豁免理由是空话。
    expect(
      consumers.size,
      'reconcilePersistedLayout 没有任何函数在调它——豁免理由（它是修理工）当场作废'
    ).toBeGreaterThan(0)
    // 它跑在持久化路径上（#575：那条断言在写入路径上抛且用户可达），抛出即那次写入崩。
    expect(
      throwsInside,
      'reconcilePersistedLayout 出现了 throw——它跑在持久化路径上，抛出即让那次写入崩溃，豁免理由作废'
    ).toBe(0)
  })

  it('豁免前提自检 2：layoutForActiveTopic 的产物只被读取面消费，绝不流回任何 reducer', () => {
    const REDUCERS = new Set(['removeTab', 'moveTab', 'moveTabToNewGroup', 'addTab', 'addTabOrThrow', 'insertTabAfter'])
    const offenders: string[] = []
    let callers = 0
    for (const relative of sourceFiles(RENDERER)) {
      const file = parse(RENDERER, relative)
      const walk = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'layoutForActiveTopic'
        ) {
          callers += 1
          // 它的产物直接当某个 reducer 的实参 → 那就是把只读超集喂回了写入路径。
          const parent = node.parent
          if (parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && REDUCERS.has(parent.expression.text)) {
            offenders.push(`${relative}: layoutForActiveTopic(...) 被直接喂给 ${parent.expression.text}`)
          }
        }
        node.forEachChild(walk)
      }
      walk(file)
    }
    // 在场自检：一个调用者都没有 → 这条恒空假绿（而且那时该删掉这个豁免条目，不是留着）。
    expect(callers, 'layoutForActiveTopic 全渲染层零调用——豁免理由（它是只读投影且有人读）当场作废').toBeGreaterThan(0)
    expect(
      offenders,
      'layoutForActiveTopic 的产物被喂回了 reducer。它刻意产出 groups ⊇ 树叶的**合法超集**（投影到空的' +
        '分组摘出树但保留记录），喂回 reducer 会让 assertGroupInvariant 对着一个合法的超集抛。' +
        '写入坐标要从 storedLayout 取（见 scratch-topic-layout.ts 里 moveTabWithinActiveTopic 的说明）。'
    ).toEqual([])
  })

  it('新增第三棵分屏树时必须回答「它的接线谁守」：每个导出的叶子取值器都要被某棵树认领', () => {
    // 取值器是 split-tree 泛型原语强制调用方传的东西，故一棵新树必然导出一个。按它判、而不是按文件
    // 清单判，是因为取值器是代码为了能编译就必须写对的东西。
    const CLAIMED = new Set([ACCESSOR, 'regionLeafId'])
    // 取值器已随两棵树的定义抽进 @agentmux/layout；渲染层薄壳是 `export *`，不产出 `export const …LeafId`。
    // 两棵源码树都扫，故将来第三棵树无论落在包里还是渲染层都会被认领检查抓到。
    const found = [...exportedLeafAccessors(RENDERER), ...exportedLeafAccessors(PKG)].sort()
    expect(found.length, '扫不到任何导出的叶子取值器——扫描器失灵，本条失去意义').toBeGreaterThan(1)
    const unclaimed = found.filter((name) => !CLAIMED.has(name))
    expect(
      unclaimed,
      `渲染层新增了叶子取值器 ${JSON.stringify(unclaimed)}——那意味着有第三棵分屏树。` +
        '它的「改了集合就要断言」由谁守？请给它建一份接线闸（复用 test/helpers/leaf-set-wiring.ts），' +
        '并把它的取值器加进这里的 CLAIMED。'
    ).toEqual([])
  })
})
