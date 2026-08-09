# Region 布局的任意元数与重排

Feature: `f-24e8ffbzq`

## 用户原话（逐字，勿改写）

按提出顺序记录，每条附解读。原话是需求的唯一来源，解读只是我的理解，两者不得混淆。

### R1

> topic 和 branch 这里我想是不是让他们高度高一点, 然后在 bar 的右边可以显示和 Region 一样的宫格视图, 并且在上面展示具体对应的 agent 图标

解读：Topic/Branch 行加高，行尾放一个「和 Region 布局同构」的缩略宫格，格子里画对应 agent 的图标。
关键约束是 **同构**——宫格的几何必须由真实布局算出，不能另画一套。设计稿已交付并获批（Option A）。
此条属另一个关注面（行布局），与本 feature 共享「布局几何是 SSOT」这一条，但不在本 feature 的交付范围内。

### R2

> 加个需求, 在某个方向打开 xxx agent 或者网站的治理, 应该支持任意多个, 并自动布局

解读：本 feature 的主诉求。今天「往某方向开」大概只能开一个（一次二分）；要能在同一方向持续追加任意多个面，
且引擎自己重排到仍然可用的几何。「自动布局」= 用户只选方向与顺序，不手工调尺寸。

### R3

> 然后, 要支持右键 region 在已有布局中和其他 region 交换位置, 以及单独变成一个 tab, 或者变成一个窗口
> 应该也是只要复用 上下左右tab那个组件就行.

解读：Region 右键三个新动作——(a) 与另一个 Region 换位，(b) 抽出成独立 Tab，(c) 抽出成独立窗口。
用户明确要求**复用方向选择器组件**，这把 R2/R3/R4 绑成同一个组件家族。
待核实：多窗口是否已有底座（可能整条缺席，那 (c) 的成本与 (a)(b) 不同量级）。

### R4

> 上下左右 tab 的组件, 要重新设计, 现在不够紧凑优雅

解读：方向选择器（一行图标式，见下方来源）要重做。
注意这不是纯审美：R2 与 R3 都要往这个组件里加动作，承载力不够是功能问题，紧凑度是它的前提。

### R5

> 自动布局可以让 subagents 调研下一些比较好的算法

解读：R2 的「自动布局」不自拟方案，先调研业界成熟算法再选型。已执行，结论见「算法调研」章。

## 北极星

用户只表达**意图**（往哪个方向、放什么、和谁换），几何由引擎负责且永远可用——
任意 N 个面都不出现不可用的细条，也不需要用户手工拖尺寸。

## 判据（验收方向，非最终 acceptance）

- 同一方向连续追加到 N=9 仍每个面可用；数据层与几何层各自有判据。
- 换位 / 升 Tab / 升窗口三个动作走同一个方向选择器组件，不是三份手抄。
- 宫格与真实布局同构：几何来自布局引擎自身的数学，不存在第二份排布代码。

## 相关既存工作（引用，不抄内容）

- `#57` 目的地选择器做成一行图标式通用组件 —— 即 R4 要重新设计的对象。
- `#338` 该选择器四个方向图标箭头全反（引擎正确、显示层错）—— 重做时这条的守卫不得丢。
- `#325` 布局预设引擎（columns-3 / grid-4 / 6 / 9）已实现并已接 GUI —— R2 的自动布局可能复用它。
- `#337` Region 右键菜单已有 Split Region —— R3 三项的落点。
- `#340` Tab 右键菜单已有 rearrange 视图入口。

## 算法调研

调研于 2026-09-05，全部结论标注了「查证自一手文档/源码」与「推断」。链接见末尾。

### 分岔点只有一个：插入时嵌套还是追加

两种表示法：

- **二叉**：每个内部节点恰两个孩子 + 一个方向。一行五个面 = 四层嵌套。
- **n 元 oriented container**：内部节点有**一个方向**和一个**有序孩子列表**。一行五个面 = 一个容器五个孩子。

行为分岔发生在「往 R 右边开」这一刻：

- R 的父容器**已经是水平**时，n 元**往那个列表里插一个兄弟**，父容器宽度按 N 重分；二叉**必须再嵌一层**两孩子节点，树变深。
- 父容器方向**垂直**时，两者都要新建一个方向节点把 R 和新面包起来。

这条规则就是 i3 / Zed / VS Code 在高 N 下仍然平坦可用、而 bspwm / yabai 会漂进尴尬几何的全部原因。

### 各家怎么做

**i3 / sway（n 元，参考模型，已查证）**：容器有 orientation（`splith`/`splitv`），孩子「一个或多个」，
`splith`/`splitv` 下每个孩子等分。文档明写：**「对一个方向相同的 split container 执行 split，什么都不会发生」**——
即同向就是追加不是嵌套。要往下开就先 `split vertical`（`$mod+v`）把焦点面**包进一个新 `splitv`**。
「嵌套深度没有限制」。面太多时的出路是把容器切成 `tabbed`/`stacking`——**变标签页而不是变细条**。

**bspwm / yabai（严格二叉，已查证）**：窗口是「**满二叉树**的叶子」，内部节点有 `SPLIT_TYPE` 和 `split_ratio`。
方向靠 bspwm 的 presel（`node -p DIR`）或 yabai 的 `window --insert <north|east|south|west>`。
**破案点：两家都不得不加一个全局 `balance` 操作**——bspwm `node -B` 明写「调整 split ratio 使所有窗口占据相同面积」，
yabai 更有 `auto_balance` 在「树变化时重新平衡」。这恰好证明二叉树自己保不住「一个方向上 N 个等分」。

推断（由模型 + balance 的存在推出）：默认 `split_ratio` 0.5 时连开四个「往右」得到的是
**50% / 25% / 12.5% / 12.5% 的右倾阶梯**，不跑 `balance` 就不是四个 25%。且树深 N−1 层，
「把这一行整体调宽」「焦点在这一行里左右移」都不对应单个容器，得穿嵌套；旋转影响的是嵌套子树而不是直觉上的「那一行」。
**这正是我们要避免的。** bspwm/yabai 把它做成一个手动按键，而不是插入本身的性质。

**dwm / xmonad（无几何树，已查证 xmonad）**：布局是**纯函数** (有序窗口栈, 屏幕矩形) → 矩形列表，
用户只控制顺序与 master 比例。`Spiral`/`Dwindle` 递归交替 H/V 切分，尺寸沿栈几何递减。
优点正是「用户不指定几何，所以任意 N 都排得开」；代价是放弃「精确放这里」。

**VS Code（n 元网格，已查证源码）**：editor group 是**网格**不是二叉树。
`workbench.editor.splitSizing` 三档，逐字取自源码：`distribute`「把**所有** group 分成等份」、
`split`「把**当前** group 分成等份」、`auto`（默认）「把当前 group 分成等份，**除非所有 group 本来就已经等分**」——
即**默认是混合策略**：平时局部按比例，本来就均匀时则整体均分。溢出由 group 内的标签页吸收。

**Zed（n 元 `PaneAxis`，已查证源码，几乎就是我们要的规格）**：
`PaneAxis { axis, members: Vec<Member>, flexes: Vec<f32> }` —— 方向 + 有序孩子列表 + 每个孩子一个 flex。
`PaneAxis::split` 就分两种情况：**同向 → 往 `members` 里 `insert_pane`（不新建 axis）**；
**垂直 → 原地把那个 Member 换成 `new_axis(old, new, direction)`**。
每次 insert/remove 都把 `flexes` 重置成 `vec![1.; n]`（等分），并有不变量断言 flex 之和 ≈ 孩子数。
最小尺寸 `HORIZONTAL_MIN_SIZE = 80.` / `VERTICAL_MIN_SIZE = 100.` px，只夹拖动不拒绝 split。

**tmux（预设重算 + 唯一真的拒绝，已查证源码）**：`select-layout` 的 `even-horizontal`/`tiled`/`main-*` 是整体重算。
`layout_split_pane` → `layout_split_check_space` 要求至少 `PANE_MINIMUM * 2 + 边框`，
不够就返回 NULL 并报 **`"no space for a new pane"`**——**宁可拒绝也不做细条**。

### 空间分配的三种数学

- **等分（distribute）**：N 个孩子各 1/N。永远可用，但每次插入都**抹掉用户手调的比例**。
- **按比例 / 只吃邻居（split）**：新面只吃目标那一格的一半，其他兄弟不动。反复切同一个邻居就得到
  **50/25/12.5 的阶梯**——这正是产生细条的机制，也是 bspwm/yabai 的默认失败模式。
- **混合（auto）**：VS Code 默认。平时按比例，本来均匀就保持均匀。兼顾「尊重手调」与「自愈回均匀」。

**Squarified treemap**（Bruls/Huizing/van Wijk 2000）：贪心行填充，按「加入这个矩形会不会降低本行最差长宽比」决定
是否换行，目标是让每块尽量接近正方。**但它 unordered 且低稳定性**——数据小变动就会重排，且不保留插入顺序。
故**不适合**做交互式定向切分的主插入路径（用户期望自己选的方向和顺序被尊重），只适合当一个可选的「整理/自动排布」命令。

### 最小尺寸/溢出的四种处理（观察到的全部）

1. **拒绝 split**——tmux。
2. **只夹拖动，插入照过**——Zed（80/100px）。
3. **把溢出容器变成标签页/堆叠**——i3 `tabbed`/`stacking`、bspwm `single_monocle`、yabai `stack`、VS Code 组内标签。
   这是对「一个方向上太多了」最友好的答案。
4. **几何递减但绝不随机出细条**——spiral/dwindle。

### 选型结论：改 n 元

**「任意多个」不是严格要求 n 元——二叉能模拟——但模拟的办法恰好就是把 n 元的机件螺栓上去，
于是拿不到好处却付更多代价。** 具体地：二叉要把「同向的极大链」当成一个逻辑「行」来做等分与整体调宽
（bspwm/yabai 的 `balance` 就是在按需做这件事），且必须每次插入都重平衡否则出阶梯细条。
那等于在二叉之上重新实现「N 个孩子的列表 + 等分/flex」，还额外背着深 N−1 层的树、更多遍历、别扭的旋转/移动语义。

**所以：走 n 元。** 二叉只在「已有一套久经考验的二叉引擎且换不起」时才划算——
而即便那样也会立刻加上 `balance`，那就是付了 n 元的钱没拿 n 元的货。
与我们最像的两个编辑器（VS Code、Zed）都选了 n 元。

### 具体方案（选型落地）

1. **节点模型**：`Container { orientation, children: [Node], sizes: [flex] }` + leaf。几乎照抄 Zed 的 `PaneAxis`。
2. **插入规则（关键）**：设 `parent` 为 R 的容器。
   `parent.orientation == axisOf(D)` → **在 `parent.children` 里 R 旁边插一个**（Up/Left 插前，Down/Right 插后），**不新建嵌套**；
   否则 → 把 R 原地换成一个 `axisOf(D)` 方向的新容器，内含 `[R, new]`（按 D 排序）。
   R 是根叶子 → 建根容器。这就是 i3 的成文规则与 Zed `PaneAxis::split` 的两个分支。
3. **重排策略**：默认取 VS Code `auto` 语义（或先用 Zed 的「插入即等分」求简单）。
   只重分**受影响的那个容器**，别处不动，避免整屏跳动。另给显式的「全部均分」命令与逐边界拖动。
4. **规范化不变量（不做这条树会腐烂）**：任何 insert/remove 之后跑一遍：
   (a) 单孩子容器**塌缩**成那个孩子；(b) 孩子容器方向与父相同时**并入父**（`H[a, H[b,c]]` → `H[a,b,c]`）。
   缺了它，n 元树也会攒出冗余嵌套、退化成二叉阶梯的行为。i3 隐式做，Zed 靠插入时就不产生嵌套来回避。
   **flex 权重的转移/重归一是这条里最容易微妙搞错的地方**——Zed 直接重置成等分绕开了它，建议初版照做。
5. **最小尺寸/溢出**：组合上面第 2 与第 3 种——
   **拖动时夹住**（Zed 那样给下限），**插入时若 1/N 会低于可用下限，不拒绝也不出细条，而是把该容器自动切成标签页/堆叠条**。
   这直接满足「引擎自己重排到仍然可用」。tmux 式的拒绝更简单但对 GUI 是更差的体验。

### 这个选型的代价（诚实列出）

- **节点模型比二叉复杂**：孩子是带 flex 权重的列表，不是两个 ratio。resize 要把 delta 分摊到列表里的邻居
  并尊重最小尺寸，而不是移动一个分隔条。代码量确实更多。
- **规范化那一遍是强制的且容易微妙写错**：塌缩与同向合并必须在每次变更后跑，且要正确转移/重归一 flex。
  漏了会静默退回嵌套二叉的行为。
- **序列化/恢复更麻烦**：要存每个容器的方向 + 有序孩子 + flex 向量，并维持 flex 之和 ≈ 孩子数的不变量（Zed 有断言）。
- **焦点导航与拖动重排改成对列表操作**：比二叉多活，但**这也正是收益**——「那一行」成了一等对象，
  可以整体调宽、变标签、原子重排。

### 与本仓现状的接口

现状是严格二叉（见「现状事实」章）。改 n 元意味着 `WorkbenchRegionLayoutNode` 的 `split` variant 要从
`{ first, second, ratio }` 变成 `{ orientation, children[], sizes[] }`，
`workbenchRegionBounds` / `lineLayout` / `gridLayout` / `balanceWorkbenchRegionLayout` /
`splitWorkbenchRegion` / `removeRegionNode` 全部随之改，且**持久化的旧布局要能读进来**
（旧的二叉链应当在读入时就被规范化成扁平容器——这正好是第 4 条不变量的免费副产品）。

补一条读码所得：`lineLayout`（`:37-51`）的 `ratio: 1 / ids.length` 作用在右嵌套链上**确实是等分**
（外层取 1/N，余下的在剩余空间里继续等分）。所以**预设产出的面是等的**；
只有**手动 split** 走固定 `0.5`（`:202`）才出阶梯。这把缺陷收窄到了一处：等分的数学已经在仓里，
缺的是「手动插入时也走它」。

### 排序：R1 的宫格与这次改造的关系

R1（Topic/Branch 行尾的缩略宫格）的设计稿是把 `workbenchRegionBounds()` 移植进去，
即宫格几何来自布局引擎自己的数学，这是它「与真实布局同构」的实现方式。

含义是：**只要 `workbenchRegionBounds(root, regionId) → bounds` 这个签名不变，宫格对树形状的改造是免疫的**——
内部从二叉换成 n 元，宫格自动跟着对。所以两件事没有硬顺序依赖，但有一个软偏好：
**先改 n 元再落宫格**，可以避免宫格先照二叉的中间态验一遍、改完再验一遍。
若宫格先落地，则务必让它只经由 `workbenchRegionBounds` 取几何、不得自己走树，
否则 n 元改造会连带打坏它（而这正是「第二份排布代码」——本 feature 明确要避免的）。

### 来源

一手文档/源码已查证：i3 userguide（tree/orientation/split）、bspwm(1)、yabai(1)、
xmonad-contrib 的 Dwindle/Spiral、VS Code `workbench.contribution.ts`（`splitSizing` 三档逐字）、
Zed `crates/workspace/src/pane_group.rs`、tmux(1) + `layout.c` / `cmd-split-window.c`。
二手：squarified treemap 走的 Wikipedia 摘要（原始 PDF 调研时 503）。
推断而非查证：dwm 的 master-stack 细节、「二叉四个面之后出阶梯」这条代价、各家 N=2/5/9 的体验、
tmux `PANE_MINIMUM` 的具体数值（在 tmux.h，未读）。

## 现状事实

来源：只读审计（2026-09-05），每条都有 file:line 出处。

### 树是严格二叉，不是 n 元容器

`workbench-view-layout.ts:3-16` 的 `split` 节点恰有 `first`/`second` 两个具名孩子 + 一个 `ratio`，
没有「orientation + 有序孩子列表」这种形状。三列是**右嵌套链** `split(A, split(B, C))`（`:37-51`），
外层 ratio=1/3、内层 ratio=1/2。这决定了 R2 的选型必须先回答：留二叉还是改 n 元。

### R2 的真实约束是几何，不是上限也不是 UI

三个候选里被证伪了两个：

- **没有数量上限。** `splitWorkbenchRegion`（`:185-206`）与 `addWorkbenchRegion`
  （`workbench-tabs.ts:202-216`）只拒两件事：目标 region 不存在、新 id 撞名。没有计数检查。
  全仓唯一的 `MAX_*` 是 `MAX_FANOUT_LANES = 8`（`shared/fanout-limits.ts`），管的是 agent 扇出车道，
  与 workbench region **无关**，且是从单一 SSOT import 的（不是手抄）。
- **UI 也不挡方向。** 四个 Split 方向动作永远在场（`workbench-tab-actions.ts:59-67,152-157`）；
  被计数过滤的只有**预设**（`:96-109` 的 `presetSize >= regionCount`），所以超过 9 个面时消失的是宫格预设，
  不是方向。`control.ts:309` 的 `LAYOUT_CAPACITY_EXCEEDED` 同样只对预设抛。
- **真正的约束：几何退化。** `workbenchRegionBounds`（`:141-170`）把路径上的 ratio 连乘，**无下限**；
  每次新 split 固定 `ratio: 0.5`（`:202`），所以连续往右开就是不断对半砍最新那个面。
  两个不完整的夹取：`setWorkbenchRegionSplitRatio` 把**单个** ratio 夹在 `[0.1,0.9]`（`:264`，逐节点非累积）；
  渲染层每个 `Panel` 给 `minSize={15}`（`WorkspaceWorkbench.tsx:730,747,1063,1082`）——
  推断是「占自己父组的 15%」而非占整窗，故深嵌套仍趋近 0.15ⁿ，只是慢一点。

**结论：数据层与 UI 都允许无限往一个方向开，面只是越来越细。没有整窗最小面积。**

### 加/删不重排，重排是 opt-in

- 加：新 split 就地插入固定 `ratio: 0.5`（`:195-203`），只切目标叶子的空间，别处兄弟不动。
- 删：被删叶子的空间**由兄弟吸收，ratio 不动**（`removeRegionNode`，`:208-218`）。
- `balanceWorkbenchRegionLayout`（`:105-119`）按叶子数比例重算所有 ratio、可得等分，
  但只有控制协议 `balance` 模式（`control.ts:305`）能触达，加/删时不自动跑。
- **预设是整树替换**（`:83-99`），且**不能用于任意 N**：`:90` 要求 `current.length <= size`
  且新增数恰好补齐；尺寸固定 3/4/6/9（`:74-81`）。所以 #325 的引擎帮不到「任意 N」。

### R3 三项的成本差一个量级

- **换位：缺。** 无 `moveRegion`/`swapRegion`/`reorderRegion`，无 region 拖拽。
  最近的原语是 `placeActiveWorkbenchRegionFirst`（`:133-139`，靠 `replaceLeafOrder` 保持树形只换 id 顺序），
  但它只把活动面提到 0 号槽，不是通用移动也不是两两交换。地基可用，操作缺席。
- **升 Tab：零件齐全，未组装。** 无 `promoteRegion`/`extractRegion`，但 `move-session-view.ts:73-139`
  的 `reduceMoveSessionView` **已经在做这个形状**：`removeWorkbenchRegion` 摘下（`:84`），
  没有宿主 View 时用 `createWorkbenchTab`+`addTab` 新开一个 Tab 承载（`:118-130`）。
  只是它限于 agent/terminal 面（`:54-56`）且由 **workspace** 目标驱动。属小规模组装。
- **升窗口：整座子系统缺席。** 全仓 `new BrowserWindow` 只有两处：`main/index.ts:135` 唯一主窗，
  且被 `singleFlight(buildWindow)`（`:241`）**刻意包起来防止开出第二个**（意图见 `:238-240` 注释）；
  `browser-profile-manager.ts:204` 是 `show:false` 的离屏窗，只为写 cookie。
  其余全部 `BrowserWindow` 引用都是把那唯一一个当参数传。

  **这条与你的前提相反**：不是「复用方向组件就行」。它需要窗口注册表、逐窗 store 注水、跨窗 IPC 与生命周期，
  且与现有单窗设计正面冲突（`singleFlight` 守卫、为保护 region-close 而剥掉 Cmd+W 的自定义菜单 `:258-264`）。
  依赖顺序上它必须排在「升 Tab」之后——先要能把 region 抽成自洽的 View，才谈得上交给新窗口。

### R4 的对象与它已有的守卫

`components/OpenDestinationBar.tsx`。props 是 `{ canSplit, onSelect }`（`:98-104`），
今天渲染 **6 个动作**：`system`/`tab` + 四方向（`:36-55`），方向按钮在 `!canSplit` 时禁用（`:118-119`）。
布局是 flex：`.open-destination-bar__row{display:flex;gap:var(--sp-1)}`，按钮 `flex:1 1 auto`
（`styles/overlays.css:155-156`）。密度：容器 `width:min(272px,calc(100vw - 20px))`、
`padding/gap: var(--sp-2)`（`:125-137`）；按钮走共用 `.icon-button` = **28×28px**（`base.css:62-75`），
字形 `size={15}`（`:133`）。即 272px 内挤 6 个 28px 按钮——这就是要压缩的对象。

**#338 那次「四个箭头全反」已有守卫，重做时不得丢**：
`test/open-destination-bar.test.tsx:75` 逐个解析 chevron 路径断言尖端朝向（`:75-138`），
另有 `:54` 的「图标路由到它所画的目的地」。分屏菜单侧的方向图标由
`test/workbench-split-menu.test.tsx:84-100,174-188,203-241` 另行守（含 import 关系判据）。

### R3 的落点是数据驱动的，加项不用改 JSX

`components/RegionContextMenu.tsx` 的 `regionMenuEntries`（`:119-136`）是纯函数，
`WorkspaceWorkbench.tsx:635-650` 接线。今天的项：Message this Agent / Copy Region Address /
Copy Session Address + 由 `splitMenu` prop 注入的整段 Split/预设（`:198-214`）。
菜单刻意做成 `RegionMenuEntry` 联合 + 单次 map（`:33-42,189-226`），新动作作为新 variant 加入，
图标进 `REGION_MENU_ICONS`（`:144-148`，靠 label 联合强制穷举）。
注释（`:8-15`）明确写了：这个菜单是**知道用户点的是哪个 region** 的地方（tab 条只能猜活动面），
所以按 region 定位的移动/开窗动作本就该落这里。

### 依赖顺序

1. 树内「移动/交换 region」原语（换位、拖拽重排的前置）
2. 通用「region → 新 Tab」（可复用 `reduceMoveSessionView` 的形状）
3. 可选：加/删时自动等分（今天是 opt-in）
4. 多窗口子系统（唯一的「从零建」，且必须在 2 之后）
