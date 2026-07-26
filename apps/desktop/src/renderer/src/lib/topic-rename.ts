/**
 * Topic 行内改名输入框对键盘事件的唯一决策点。
 *
 * 改名输入框渲染在一个同时挂着 @dnd-kit sortable `{...listeners}` 的祖先 div 里（见
 * SurfaceToolDock 的 SortableTopicItem）。那个 KeyboardSensor 的 activator 监听在 `onKeyDown`
 * 上，且此处没有用 `setActivatorNodeRef`——于是 dnd-kit 里 `event.target !== activator` 的守卫
 * 失效，输入框内按下的键会一路冒泡到祖先 div 被 sensor 当作「开始拖拽 / 移动」并 `preventDefault`。
 * 这正是用户报的「不能打空格, 不能方向键」：空格是 sensor 的启动键、方向键是移动键，都被吞掉。
 *
 * 修法是让输入框拦下自己收到的每一个按键，不让它到达祖先的 listener——sensor 依旧挂在 div 上，
 * 用键盘拖拽整行 Topic 照常可用（那是 div 自己聚焦时收到的键，不经过输入框）。
 */

/** React.KeyboardEvent 的最小结构子集，便于用普通对象在单测里断言而无需真实 DOM 事件。 */
export interface TopicRenameKeyEvent {
  key: string
  stopPropagation(): void
  preventDefault(): void
}

export interface TopicRenameKeyHandlers {
  /** 放弃本次编辑，回到只读行。 */
  cancel(): void
}

/**
 * Pure：一个按键事件与一组回调进，副作用只发生在传入的 event / handlers 上，没有 Store、没有 DOM。
 *
 * - 任何键都 `stopPropagation`：把键留在输入框里，绝不让拖拽 sensor 看到它。这一句就是空格与方向键
 *   复活的原因，删掉它两者立刻再次「死掉」。Enter 不在这里处理——它靠表单默认的 submit 提交，
 *   `stopPropagation` 不影响默认动作，故提交照常。
 * - Escape 额外取消编辑，并 `preventDefault` 以免触发别处的默认行为。
 */
export function handleTopicRenameKeyDown(
  event: TopicRenameKeyEvent,
  handlers: TopicRenameKeyHandlers
): void {
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    handlers.cancel()
  }
}
