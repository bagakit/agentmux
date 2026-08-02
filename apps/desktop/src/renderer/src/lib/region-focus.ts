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

/** 焦点态的类名。CSS 侧 `.workbench-region--active::after` 是它唯一的消费者。 */
export const REGION_FOCUS_CLASS = 'workbench-region--active'

export function regionFocusExpression(
  activeRegionId: string | null | undefined,
  regionId: string
): RegionFocusExpression {
  // 这一个比较就是全部判定。两个返回字段都由它算出，不许任何调用方自己再比一次。
  const focused = activeRegionId === regionId
  return { className: focused ? REGION_FOCUS_CLASS : '', nativeViewYieldsToRing: focused }
}
