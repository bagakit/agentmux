/**
 * 「这一格是不是当前聚焦的那一格」——**一个决定，两个消费者。**
 *
 * 焦点环由 CSS 画（`.workbench-region--active::after`），而 browser 那格的内容是窗口级的原生
 * `WebContentsView`，合成在全部 renderer 像素之上、连那层覆盖层也盖不住它。唯一修法是让原生视图的
 * 矩形按环宽内缩（`nativeBoundsClearOfFocusRing`）。于是同一件事有了两个消费者：挂类名的人，和
 * 决定要不要让位的人。
 *
 * 这两个消费者必须读同一次判定。分开各算一次的后果实测过：BrowserPane 那侧原来只问「有没有
 * `.workbench-region` 祖先」，而环宽那个自定义属性声明在 `:root`，任何 Region 都继承得到，于是
 * **未聚焦**的 browser 区也内缩 2px——露出底下 `.browser-stage` 的深色（`--surface-0` #111419），
 * 网页多为浅色时那是一条看得见的深边，而它没有对应的绿环。用户看到的是「没聚焦的那格镶了一圈黑边」。
 * 记忆 read-key-and-write-key-must-be-one-decision 的同一族：读的 key 与写的 key 分开算两次必漂移。
 *
 * 所以这里返回的是**一对**：类名与「原生视图要不要让位」。返回 `''` 而不是 undefined，让调用方能
 * 直接拼进 className 而不必再判一次空。
 */
export type RegionFocusExpression = {
  /** 挂到 Region 上的焦点类名；不是焦点时是空串。 */
  className: string
  /** 原生视图（browser 那格）要不要按环宽内缩让位。 */
  nativeViewYieldsToRing: boolean
}

/**
 * Region 容器自己的类名。**三个消费者读同一个字符串**，所以它只能有一处：
 *   - 组件挂到那个 `<section>` 上；
 *   - CSS 按它写默认态与焦点态的规则；
 *   - BrowserPane 用 `closest()` **反查**这个祖先，据此把原生视图夹进 Region。
 *
 * 第三个消费者是这里非要有个常量的理由。它原来手抄成 `stage.closest('.workbench-region')`：那个字符串
 * 与元素实际带的类名分居两个文件，拼错一个字母的后果是 `closest` 恒返回 null → 整个 `if (region)`
 * 分支变成死代码 → 原生视图回到满铺 → 焦点环的左/右/下三边被物理遮掉（#341 原样）。而两侧的类型、
 * tsc、以及所有既有断言全都沉默：查询用的字符串与被查的类名之间没有任何编译期联系。收成一个常量后
 * 这两侧只有一个真相，拼错它会同时打掉 CSS 规则查找与容器类名。
 */
export const REGION_CLASS = 'workbench-region'

/** 焦点态的类名。CSS 侧 `.workbench-region--active::after` 是它唯一的消费者。 */
export const REGION_FOCUS_CLASS = `${REGION_CLASS}--active`

/**
 * Pane 组焦点态的类名。CSS 侧 `.pane-group--focused::after` 是它唯一的消费者。
 *
 * 基类名 `pane-group` 刻意**不**收成常量：它没有跨文件的反查消费者（Pane 组的反查走
 * `[data-pane-group-id]` 这个 data 属性，不走类名），为一个消费者立一个常量只是熵。
 */
export const PANE_GROUP_FOCUS_CLASS = 'pane-group--focused'

/**
 * 焦点环该不该出现——**它表达的是「在若干候选里选中了这一个」，候选只有一个时这句话没有内容。**
 *
 * 用户原话：「现在表示选中的框, 除了活跃的 region 有, 整个界面也有」。现场是两层环各自无条件跟着
 * 「谁是活动的」画，而两层都存在「候选恒为一」的常态形态：
 *   - 不分屏时（`layout.root` 就是一片叶子）唯一的 Pane 组铺满整个工作区，且恒等于 `activeGroupId`；
 *   - 单格 Tab 里唯一的 Region 铺满内容区，且恒等于 `activeRegionId`。
 * 于是最常见的形态（单窗口、不分屏、一格）界面外沿是一圈绿框、往里 2px 再一圈——两圈都不携带任何
 * 信息，而它们本该是「焦点在这一格」的唯一线索。噪声不只是不好看：一个恒亮的环让真正需要它的时候
 * （分屏后）也读不出差别。
 *
 * 判据是 `> 1` 而不是 `!== 1`：数不出候选（0）时保守地不画，而不是把「数坏了」表达成「画上」。
 *
 * 与「这一格关不关得掉」（`canClose`）今天答案一致，但那是两个问题——一个问「还有别处可去吗」，
 * 一个问「有差别要表达吗」。今天一致是因为规则本身一致，不是因为它们是同一个决定，所以不合并
 * （同 `scratch-topic-layout.ts` 里 `visible` 与 `tabEligibilityForActiveTopic` 的处理）。
 */
export function focusRingExpressesChoice(candidateCount: number): boolean {
  return candidateCount > 1
}

export function regionFocusExpression(
  activeRegionId: string | null | undefined,
  regionId: string,
  regionCount: number
): RegionFocusExpression {
  // 这一个判定就是全部。两个返回字段都由它算出，不许任何调用方自己再判一次——候选数这一问也必须
  // 落在这里而不是只挂到类名那一侧：只让类名变空而让位量照旧为真，就是 #350 那圈「无环的深边」。
  const focused = activeRegionId === regionId && focusRingExpressesChoice(regionCount)
  return { className: focused ? REGION_FOCUS_CLASS : '', nativeViewYieldsToRing: focused }
}

/**
 * Pane 组那一层的同一句话。
 *
 * 与 Region 那层是**两个决定**而不是一个：候选集不同（这一层数的是分屏树里的叶子，那一层数的是
 * Tab 内的格），活动项也来自不同的字段（`layout.activeGroupId` vs `tab.layout.activeRegionId`）。
 * 共用的只有「候选只有一个就别画」这条规则，所以共用的是 {@link focusRingExpressesChoice} 而不是
 * 整个判定。这一层没有原生视图要让位（原生表面活在 Region 里），故只返回类名。
 */
export function paneGroupFocusClass(
  activeGroupId: string | null | undefined,
  groupId: string,
  groupCount: number
): string {
  const focused = activeGroupId === groupId && focusRingExpressesChoice(groupCount)
  return focused ? PANE_GROUP_FOCUS_CLASS : ''
}

/**
 * 一次「让这一格成为焦点」是**因何发生的**——而这个因决定了它除了搬绿环，要不要把**打字光标（DOM
 * caret）**也搬进那一格的表面。
 *
 * 为什么这是一个独立的纯判定，而不是复用 {@link regionFocusExpression} 的「谁是焦点」：焦点环表达的是
 * 一个**状态**（哪一格现在是活动的），它不携带「这次变化是键盘导航还是指针点击」这个信息。而 caret 该不该
 * 被夺走恰恰只由后者决定：
 *   - 键盘方向导航（`Cmd+Alt+方向`）搬焦点时，用户看不见的 DOM 焦点还停在原来那格的 xterm/Monaco 上，
 *     不主动搬过去，敲的字就全进了上一格——这正是本判定要修的缺陷（绿环移了、键入没移）。
 *   - `onPointerDown` 落焦时**不能**搬：浏览器/xterm 的原生 mousedown 已经把 DOM 焦点放到了点中的位置，
 *     这里再 `.focus()` 一次会打断原生行为，还可能在一次文本选择的中途把焦点夺走。
 * 若让表面去读「我现在是不是焦点格」来决定搬 caret，指针点击那一路也会满足条件，于是每次点都夺焦——所以
 * 判据必须是**因**（cause），不是**果**（focused 状态）。这与 region-focus.ts 顶部记的 #350 同一条纪律：
 * 一件事只在一处判定，别在消费侧凭另一个信号重新推一遍。
 *
 * 未知的 cause 保守地**不**搬（返回 false）：宁可少搬一次（用户可再点一下），也不要在不该夺焦时夺焦。
 */
export const REGION_FOCUS_CAUSES = ['keyboard', 'pointer'] as const
export type RegionFocusCause = (typeof REGION_FOCUS_CAUSES)[number]

export function regionFocusClaimsCaret(cause: RegionFocusCause): boolean {
  return cause === 'keyboard'
}

/**
 * 一条「搬 caret」意图是否**精确点名了这一格**。
 *
 * 搬 caret 的机制是一条按 regionId 定位的一次性意图（`store.regionCaretFocus`，consume-and-clear，同
 * `closeRegionRequest`）：`focusRegion` 在 {@link regionFocusClaimsCaret} 为真时投递它，承载该格的表面
 * （TerminalView / EditorPane）读到点名自己那条就把 DOM 焦点搬进来、然后清掉。
 *
 * 两个表面**共用这一个匹配器**，而不是各写一句 `request?.regionId === myRegionId`：那样就是「同一个判断有
 * 两个写入点」，其中一处漏改（比如把 `===` 写成别的、或忘了判 null）只坏一个表面，而另一个照旧全绿。
 * region id 全局唯一（`newRegionId` / uuid），所以只比 regionId 足矣，不必再带 workspace/tab。
 */
export function regionCaretFocusTargets(
  request: { regionId: string; nonce: number } | null | undefined,
  regionId: string | null | undefined
): request is { regionId: string; nonce: number } {
  return request != null && regionId != null && request.regionId === regionId
}
