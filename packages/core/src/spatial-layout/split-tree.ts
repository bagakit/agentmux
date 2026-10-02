// 分屏树的 SSOT。工作区的 tab-group 布局（workbench-layout.ts）与 tab 内的 region 布局
// （workbench-view-layout.ts）是**同一棵树**：一个带方向与比例的二叉分屏，叶子上挂各自的载荷。
// 两边只有叶子载荷不同（groupId vs regionId），所以「比例夹取、按路径改比例、关闭叶子后找兄弟」
// 这套树代数只应存在一份——此前它被抄了两份并已经漂移（比例上界、比例可选性、关闭后的重聚焦
// 三处各不相同），本文件把它收回一处。
//
// 叶子载荷用泛型 Leaf 表达；两个具体节点类型是它的实例（见各自文件的 type 别名）。

export type SplitTreeNode<Leaf> =
  | ({ type: 'leaf' } & Leaf)
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: SplitTreeNode<Leaf>
      second: SplitTreeNode<Leaf>
      ratio: number
    }

// 直接写成交集，而不是 Extract<SplitTreeNode<Leaf>, {type:'leaf'}>：后者在 Leaf 还是类型参数时
// 不保证被解成这个交集，会让泛型函数里的叶子入参类型对不上。
export type SplitTreeLeaf<Leaf> = { type: 'leaf' } & Leaf

// 分屏比例的下限＝渲染层 Panel 的 minSize（见下面的 MIN_SPLIT_PERCENT，渲染层从它派生而非手抄）。
// 两者必须是同一个数：拖动落点被 react-resizable-panels 夹在 [minSize, 100-minSize] 内，若写回 store
// 的比例允许比它更极端，面板会在下一次渲染把自己弹回边界、视觉上跳一下。此前 region 树用 0.1、
// tab-group 树用 0.15，前者就落在「模型允许、视图不允许」的缝里。取 0.15 让「模型能存的最窄」与
// 「视图能显示的最窄」重合。上界对称派生（1 - 0.15 = 0.85），不再单列第二个常量。
// 改这个数就是产品决策——一个面板最窄能到多窄——所以整仓只此一处。
export const MIN_SPLIT_RATIO = 0.15

// 同一个下限的百分比表达，给渲染层的 <Panel minSize={…}> 直接消费（react-resizable-panels 的
// minSize 以 0–100 计）。渲染侧曾把裸字面量 15 手抄四遍、只靠注释宣称「必须＝MIN_SPLIT_RATIO」——
// 把 MIN_SPLIT_RATIO 调到 0.2 时那四处纹丝不动，模型夹到 [0.2,0.8] 而视图仍让人拖到 15%，正是
// :23-27 说已经闭合的那道缝。改成从这里派生后，动一个数两侧一起动，编译期保证同值，无需测试守。
export const MIN_SPLIT_PERCENT = MIN_SPLIT_RATIO * 100

// 「没人记过这条分隔条在哪」时它在哪：正中间。两棵树的构造器（buildSplitNode / splitWorkbenchRegion）
// 与渲染层对缺失 ratio 的兜底本来各写一份 0.5，整仓共六处手抄——而这**不是**六个独立的选择，是同一个
// 产品决定（新开的分屏均分）。收成一处的直接理由见 clampSplitRatio 下面那段：#533 我把归一化装到持久化
// 边界上时，边界的判断与渲染层的判断分居两处，于是它们对同一个缺失值给出了不同答案。
export const EVEN_SPLIT_RATIO = 0.5

/**
 * 把一个比例夹回 [MIN_SPLIT_RATIO, 1-MIN_SPLIT_RATIO]，并且**对非有限输入也有定义**。
 *
 * 非有限那一半是 #552 的修复，而它是我自己 #533 的回归。裸的 `Math.max(min, Math.min(max, ratio))`
 * 对 `undefined` 求值是 `NaN`——不是抛错，不是原样返回，是一个会**沿着写入路径传播**的坏值：
 *   1. `clampSplitTreeRatios` 的身份早退比的是 `ratio === root.ratio`，而 `NaN === undefined` 为假，
 *      所以它不但没把树原样放过去，还**主动重建**了一棵带 NaN 的树；
 *   2. 那棵树走的是 zustand 的 `partialize`，即**落盘**。`JSON.stringify(NaN)` 是 `null`；
 *   3. 下次读回来 `null`，`null ?? 0.5` 才终于兜到 0.5——但中间那一帧的 `NaN * 100` 让
 *      `<Panel defaultSize={NaN}>` 拿到 NaN，且 `NaN ?? 0.5` 仍是 NaN（`??` 只认 null/undefined）。
 * 也就是说：渲染层当时那道 `?? 0.5` 明明是给「可能缺 ratio 的历史持久化数据」留的防线
 * （见 workbench-layout.ts 里 `TabGroupLayoutNode` 上方那段的原话），而我把归一化装在**它上游的写入
 * 边界**上，于是防线永远等不到
 * 它要防的那个值——等到的是一个 `??` 接不住的 NaN。缺省值必须由**边界**给出，不能留给下游兜。
 * 那道 `??` 已随本修复撤掉，但**别把「渲染层无条件调本函数」当成今天的真相**：只有 tab-group 那条
 * 路径这么做（`SplitBranch`）。region 那条路径（`WorkbenchRegionBranch`）把 `node.ratio` **裸着**
 * 交出去，四个交接口：两个 `<Panel defaultSize>`，以及分屏提交器的构造参数与
 * `synchronizePersistedRatio`。两条路径今天都安全，但靠的不是同一层：
 *
 * - **tab-group**：渲染层自己夹一次，所以即使上游漏了也画得对。
 * - **region**：靠「每个写入点都夹过」这条上游不变量——`setSplitRatioAtPath` 是唯一的按路径写入口
 *   （见下面它自己的实现，两个 store action 都经它），`balanceNode` 自己夹（#521），
 *   `rowLayout`/`gridLayout` 的 1/N 里 N ≤ 3 天然在界内，而**持久化读回来的那棵树**由
 *   `clampSplitTreeRatios` 无条件归一化（workbench-persistence.ts:75/105，两棵树都走）。
 *
 * 写清这条差别是因为它决定了「新增一个写 `ratio` 的地方时要不要自己夹」：region 那条路径上，答案是
 * **要**——渲染层不会替你兜。反过来说，削弱任何一个写入点的夹取就是真回归：把
 * `setSplitRatioAtPath` 里的 `clampSplitRatio(ratio)` 换成裸 `ratio`，实测三个 suite 各红一条
 * （split-tree-substrate / workbench-layout / workbench-region-split-guards）。
 *
 * 这个不变量的**最薄一处曾经是分屏提交器的构造参数**：它既不在渲染层的夹取下，也不在「写入点自己夹」
 * 这条链上——它读的是树里现成的值，而它的死区比较（`Math.abs(x - NaN) <= ε` 恒假）会把坏值**提交**
 * 出去而不是丢掉。#595 已经把这一处补上：`SplitRatioCommitter` 现在在**它自己的两个入口**（构造参数与
 * `synchronizePersistedRatio`）各调一次本函数，所以那两处虽然字面上仍裸着交，被调方却已经夹过——这条
 * 不再是最薄的一处，而且它是被测试钉着的：terminal-interaction-latency.test.ts 的「死区的基准操作数
 * 也要在入口归一化（#595）」，四个变异（两个入口 × 不夹／只判有限）各有专属的红。
 *
 * **今天最薄的一处改成了 `WorkbenchRegionBranch` 里那两个 `<Panel defaultSize={node.ratio * 100}>`**：
 * 它们仍然直接读树里的值，而且**没有任何测试或类型检查覆盖它们收到坏值时会怎样**——`defaultSize={NaN}`
 * 之后 react-resizable-panels 的行为本仓没验过，所以这里只说「无人守」，不替它编一个症状。要动这两处
 * （或新增一个把 ratio 交给渲染层的地方）时，前提仍是上面那条「每个写入点都夹过」的上游不变量。
 *
 * 上面这三段关于「谁夹了谁没夹」的话本身有判据：split-ratio-handoff-guards.test.ts 按 AST 找出两个
 * 渲染函数的全部交接口，逐个质询取值里有没有夹过，两个方向都会红（tab-group 不夹了、region 开始夹了）。
 * #578 就是这段话变假之后没人发现——所以它不再只是散文。那道守卫也写明了自己的三个盲点，其中一条正是
 * 「它不执行组件」，别把它读成「这两个 `<Panel>` 已经有人守」。
 *
 * 注意这几段刻意只点**函数名**不写行号：这个组件是并发热点，写死行号的锚点在别人提交的那一刻就漂了
 * （本仓这一族已复发 8 次），由那道守卫负责把名字翻译成位置。
 *
 * 为什么是「给默认值」而不是「原样放过去」：缺失的 ratio 没有歧义。类型上 `ratio` 是必填，
 * 一条没有它的记录只可能来自更早的代码，而那个年代的意思与今天完全一致——均分。含糊的缺席才需要
 * 保留原样等下游判断（本仓 authored-vs-derived-is-the-wrong-axis 记的就是这条判据），这一条不含糊。
 */
export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return EVEN_SPLIT_RATIO
  return Math.max(MIN_SPLIT_RATIO, Math.min(1 - MIN_SPLIT_RATIO, ratio))
}

/**
 * 把整棵树的每个 `ratio` 夹回 [MIN_SPLIT_RATIO, 1-MIN_SPLIT_RATIO]，并在**没有一处越界时返回原引用**。
 *
 * 为什么需要这一层：`clampSplitRatio` 只夹**新算出来的**那一个值，所有调用点都在「用户此刻拖了分隔条」
 * 或「刚重算了配比」这类**写入**路径上。而从 localStorage 读回的一棵树的 ratio 谁也没夹过——它们是
 * **旧版本的代码**写下的，而那时的下界不是今天这个数（region 树曾用 0.1，见 :23-28 记的那次收敛）。
 * 一条 0.12 的记录在当年合法，今天越界：模型允许 0.12、视图的 `minSize` 只到 15%，于是面板画出来是
 * 15% 而 store 里存着 12%，拖一次分隔条的提交器观察到被夹过的布局又把修正值写回——一帧跳动加一次多余
 * 写入，正是 `balanceNode` 那段注释描述的同一种症状，只是这次的越界值来自磁盘而不是算式。
 *
 * 引用稳定（没夹到任何一处时返回原引用）买到的是**省掉一次分配**，不是正确性：持久化边界在
 * 每次写入（zustand 的 `partialize`）上跑这一层，而绝大多数写入的树本就在界内，无条件重建等于
 * 每次拖动都白造一棵树。要如实说清它**没有**买到什么：本仓今天没有任何消费者按引用比较这棵树
 *（`partialize` 的产物直接 `JSON.stringify` 进 localStorage，恢复侧的产物进一次全新的 `set()`），
 * 所以谁也不该把「引用没变」当成一个可依赖的合同——那会让一次正当的重构变成假回归。
 * 测试里钉住这条身份，钉的是这个优化，不是不变量；断言的措辞要说明这一点。
 *
 * 泛型的理由与本文件其余部分相同：两棵树（tab-group 与 region）的 ratio 是同一件事，
 * 只有叶子载荷不同。归一化只写一份，两边都从这里取。
 */
export function clampSplitTreeRatios<Leaf>(root: SplitTreeNode<Leaf>): SplitTreeNode<Leaf> {
  if (root.type === 'leaf') return root
  const first = clampSplitTreeRatios(root.first)
  const second = clampSplitTreeRatios(root.second)
  const ratio = clampSplitRatio(root.ratio)
  if (first === root.first && second === root.second && ratio === root.ratio) return root
  return { ...root, first, second, ratio }
}

function updateRatioAtSegments<Leaf>(
  root: SplitTreeNode<Leaf>,
  path: string[],
  ratio: number
): SplitTreeNode<Leaf> {
  if (path.length === 0) return root.type === 'split' ? { ...root, ratio } : root
  if (root.type !== 'split') return root
  const [segment, ...rest] = path
  if (segment === 'first') return { ...root, first: updateRatioAtSegments(root.first, rest, ratio) }
  if (segment === 'second') return { ...root, second: updateRatioAtSegments(root.second, rest, ratio) }
  return root
}

// nodePath 用 '.' 分段（'first.second'…），空串＝根。比例在此统一夹取一次，调用方不再各自夹。
export function setSplitRatioAtPath<Leaf>(
  root: SplitTreeNode<Leaf>,
  nodePath: string,
  ratio: number
): SplitTreeNode<Leaf> {
  return updateRatioAtSegments(root, nodePath ? nodePath.split('.') : [], clampSplitRatio(ratio))
}

function firstLeafId<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string
): string {
  return root.type === 'leaf' ? leafId(root) : firstLeafId(root.first, leafId)
}

// 关闭一片叶子后谁接管焦点：它的**兄弟**。在二叉分屏里，删掉一片叶子时它的兄弟子树被提升到父节点
// 的位置——正是视觉上长大、占掉被关格所空出那块地方的那一格，所以焦点落到兄弟才符合用户「关掉这格、
// 看向补上来的那格」的动作。兄弟本身是子树时取其第一片叶子（与 removeLeaf 提升子树后的读序一致）。
// 返回 null 表示 target 不在树里、或 root 本身就是叶子（没有兄弟）。
export function findSiblingLeafId<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string,
  targetId: string
): string | null {
  if (root.type === 'leaf') return null
  if (root.first.type === 'leaf' && leafId(root.first) === targetId) {
    return firstLeafId(root.second, leafId)
  }
  if (root.second.type === 'leaf' && leafId(root.second) === targetId) {
    return firstLeafId(root.first, leafId)
  }
  return (
    findSiblingLeafId(root.first, leafId, targetId) ??
    findSiblingLeafId(root.second, leafId, targetId)
  )
}

// 树里所有叶子的 id，按读序（先序：左→右 / 上→下）。两棵树的 groupIds / regionIds 此前各自递归一份
// 逐字相同的实现，现在都只是本函数的转发壳。读序是有合同的：`findSiblingLeafId` 提升子树后取「第一片
// 叶子」用的就是这个序，关格后的焦点落点依赖两者一致。
export function collectLeafIds<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string
): string[] {
  if (root.type === 'leaf') return [leafId(root)]
  return [...collectLeafIds(root.first, leafId), ...collectLeafIds(root.second, leafId)]
}

/**
 * 「一棵树的叶子 id」与「它的记录表的键」是不是**逐一对应**（多重集相等）。
 *
 * 两棵树各有一条无条件 throw 的生产断言（`assertRegionInvariant` / `assertGroupInvariant`）判的都是
 * 这件事，此前各自手抄一份比较，而两份**曾经不一样**：region 侧排序逐元素 + 比长度，group 侧用两个
 * 方向的 `Set` 差集。差集对**重复**完全失明——`[g1]` 配 `[g1, g1]` 两个方向的差都是空，于是同一种
 * 违约在一侧抛、在另一侧沉默（#571）。判据收成这一份，两条断言就不可能再分家。
 *
 * 为什么是多重集而不是集合：重复本身就是违约。
 *   - 树里同一个 id 两片违反 {@link removeLeaf} 写明的前置条件（它会摘掉**所有**同名叶，一次收格连坐
 *     删掉另一格）；
 *   - 记录侧重复只在 `groups` 这种**数组**表上可能（对象表一个键只存一条），第二条记录永远取不到、
 *     也永远回收不掉。
 * 排序后逐元素比较同时认得出「谁多谁少」与「多了一份重复」，比长度是必要的一半：只逐元素比较时，
 * 短的一侧比完就停，长出来的尾巴无人看见。
 *
 * 只回答是/否。差在哪里由调用方自己按需要算——两条断言的错误消息各自要说自己那层的名词
 *（Region / Tab Group），把消息也收进来只会让这里替它们编词。
 */
export function leafIdsMatchRecords(tree: readonly string[], records: readonly string[]): boolean {
  if (tree.length !== records.length) return false
  const sortedTree = [...tree].sort()
  const sortedRecords = [...records].sort()
  return sortedTree.every((id, index) => id === sortedRecords[index])
}

// 把 targetId 那片叶子整体换成 replacement（可以是一片叶子，也可以是一棵 split 子树——「在这一格上
// 再切一刀」就是后者）。targetId 不在树里时整棵树原样返回。
export function replaceLeaf<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string,
  targetId: string,
  replacement: SplitTreeNode<Leaf>
): SplitTreeNode<Leaf> {
  if (root.type === 'leaf') return leafId(root) === targetId ? replacement : root
  return {
    ...root,
    first: replaceLeaf(root.first, leafId, targetId, replacement),
    second: replaceLeaf(root.second, leafId, targetId, replacement)
  }
}

/**
 * 把重复出现的叶子 id 收成一片：同一个 id 在树里出现多次时，**保留读序里第一次出现的那片**，
 * 其余同名叶按 {@link removeLeaf} 的规则摘掉（所在 split 塌缩、兄弟提升）。没有重复时返回原树
 * （同一引用），故调用方可以用 `===` 判「动过没动过」。
 *
 * 为什么需要它，而 {@link removeLeaf} 不够：removeLeaf 是纯递归，摘的是**所有**同名叶（那条选择
 * 有它自己的理由，见其说明），所以拿它去重会把整个 id 从树里删干净——这不是去重，是删格。
 *
 * 为什么保留「第一次出现」而不是别的：`collectLeafIds` 的读序是有合同的（关格后的焦点落点依赖它），
 * 而两棵树的**记录表**（`layout.groups` 数组 / `tab.regions` 对象）对一个 id 只存一条，所以「哪一片
 * 是真的」在数据里根本没有答案。读序首片是唯一不需要额外信息、且与焦点规则同序的选择。
 *
 * 谁该调它：**只有持久化边界**。两棵树的 reducer 都产不出重复叶（tab-group id 现造，
 * `splitWorkbenchRegion` 显式拒绝已在场的 regionId，见 removeLeaf 的前置条件「叶子 id 在一棵树内
 * 唯一」），但 localStorage 里的东西是用户数据、可以长成任何合法类型的形状。而两条不变量断言
 * （`assertGroupInvariant` / `assertRegionInvariant`）都是无条件 throw 的生产断言，其中 region 那条
 * 已经能认出重复叶——实测一张 `[r1, r1]` / `{r1}` 的持久化 Tab 在 partialize 与启动恢复**两个入口
 * 都抛**，而抛在 partialize 里意味着任意一次用户操作变成崩溃且此后再也写不进去。抢救必须先能修它，
 * 断言才有资格认它。
 */
export function dedupeLeafIds<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string
): SplitTreeNode<Leaf> {
  const seen = new Set<string>()
  // 一次先序遍历：叶子第一次见到就留下，再见到就返回 null（＝这一片不要了）。split 的两侧都没了就整个
  // 没了，只剩一侧就把那一侧提升上来——塌缩规则与 {@link removeLeaf} 逐字相同，只是判据从「id 等于
  // target」换成「这个 id 之前见过」。先序保证「之前见过」的那一片正是 collectLeafIds 读序里的首片。
  //
  // 不要试图用 removeLeaf 拼出这件事：它摘的是所有同名叶，所以「先把要留的那片换成哨兵、摘掉其余、
  // 再换回来」这条路走不通——哨兵 id 只活在一个合成字符串里，而 leafId() 读的是叶子的载荷，于是哨兵
  // 从来不在树里，removeLeaf 照旧把所有副本删干净（实测 6 例里 5 例错，相邻重复完全不去重、
  // 非相邻重复则两片都没了）。
  const walk = (node: SplitTreeNode<Leaf>): SplitTreeNode<Leaf> | null => {
    if (node.type === 'leaf') {
      const id = leafId(node)
      if (seen.has(id)) return null
      seen.add(id)
      return node
    }
    const first = walk(node.first)
    const second = walk(node.second)
    if (!first) return second
    if (!second) return first
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  // 整棵树至少有一片叶子，且首片必然留存（`seen` 起初是空的），所以 walk 在根上恒不返回 null。
  // 这个 `?? root` 是不可达的兜底，不是一条能举例说明的规则。
  return walk(root) ?? root
}

/**
 * 摘掉 targetId 那片叶子：它所在的 split 塌缩，兄弟子树被提升到父节点的位置（正是视觉上长大、占掉
 * 空位的那一格，与 {@link findSiblingLeafId} 的焦点规则同一件事）。整棵树只剩这一片叶子时返回 null，
 * 由调用方决定「空树」在它那层是什么意思（关掉整个 Tab、还是拒绝动手）。
 *
 * **纯递归，不带「命中直接子叶就返回兄弟」的快捷路径。** 两者只在一种输入上分家：同一个 id 既是某个
 * split 的直接子叶、又出现在它的兄弟子树里——快捷路径只删前者，纯递归两个都删。本仓到不了那种输入
 * （两棵树的叶子 id 都互不相同：tab-group id 现造，`splitWorkbenchRegion` 显式拒绝已在场的 regionId），
 * 所以这里选纯递归不是为了修一个真 bug，而是因为**少一条分支就少一个无人守的形状**；实测两种写法在
 * 26038 个唯一 id 随机树上零差异。前置条件写在这里：叶子 id 在一棵树内唯一。
 */
export function removeLeaf<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string,
  targetId: string
): SplitTreeNode<Leaf> | null {
  if (root.type === 'leaf') return leafId(root) === targetId ? null : root
  const first = removeLeaf(root.first, leafId, targetId)
  const second = removeLeaf(root.second, leafId, targetId)
  if (!first) return second
  if (!second) return first
  return { ...root, first, second }
}
