/**
 * 叠压头像簇里，每种记号落哪个角——一处决定，不让每种记号在自己的 CSS 规则里就近挑。
 *
 * 几何前提（从样式表反推，不照注释抄）：头像 18px，`.selector-presence__slot + .selector-presence__slot`
 * 负 `margin-left: calc(-1 * var(--sp-3))` = 6px，z-index 随 DOM 序左→右递增，所以**右压左**：
 * 每一枚自己的右 6px 被右邻座整枚盖住，左侧在上。四角里只有**左上、左下**落在可见带上。
 *
 * 可见角两个，记号四种，所以必须排序。排序判据是「看不见的代价谁更大」，裁决与理由写在密度合同
 * 的「叠压头像簇的角位分配」，这里只落地，不复述。
 *
 * 为什么要有这个模块而不是直接在 CSS 里写死四个方位：各写各的，下一个新记号仍会就近落进被盖的
 * 右侧带——那正是本次要修的缺陷，它会原样复发。让 CSS 与测试都从这一份取值，加记号时必须在这里
 * 排它的位置，而不是找一个看起来还空着的角。
 */

/** 叠压簇中的四个角。`left-*` 在上，`right-*` 被右邻座盖住。 */
export type PresenceMarkCorner = 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right'

/**
 * 记号 → 落角。键是它在样式表里的类名后缀，使测试能从这里反推该去核哪条规则。
 *
 * `monogram` 今天还没渲染（f-27a8f3deq/T-002 被阻塞），登记在这里是因为本分配的全部意义就是
 * **先把位置排完再落地**；留着它不登记，下一个人就会重演「找一个还空着的角」。
 */
export const PRESENCE_MARK_CORNERS = {
  /** 注意力 `?`/`!`——全产品最响的通报，拿第一个可见角。 */
  status: 'top-left',
  /** provider 归并计数——读错会数错 Agent 数量，拿第二个可见角。 */
  count: 'bottom-left',
  /** 用户自定义徽标——静态装饰，不通报变化中的事实，四者里唯一可让的一个。 */
  badge: 'top-right',
  /** 显示名字母牌——登记占位。它最需要被看见时（簇里有多枚）恰好被盖住，所以角标位交付不了它。 */
  monogram: 'bottom-right'
} as const satisfies Record<string, PresenceMarkCorner>
