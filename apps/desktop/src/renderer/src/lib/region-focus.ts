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

export function regionFocusExpression(
  activeRegionId: string | null | undefined,
  regionId: string
): RegionFocusExpression {
  // 这一个比较就是全部判定。两个返回字段都由它算出，不许任何调用方自己再比一次。
  const focused = activeRegionId === regionId
  return { className: focused ? REGION_FOCUS_CLASS : '', nativeViewYieldsToRing: focused }
}
