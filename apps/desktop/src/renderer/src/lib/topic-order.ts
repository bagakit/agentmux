/**
 * Topic 的展示顺序。
 *
 * 今天的顺序来自目录名的字典序（`scratch-topics.ts:165`）——`topicId` 由时间戳派生，
 * 那约等于创建序：稳定，但用户改不了。拖拽引入的是一份**用户意图**，它必须和
 * "文件系统随时可能多出或少掉一个 Topic"这件事共存，因此：
 *
 *   - 用户顺序是一份**偏好**，不是真相来源。磁盘上没有的 Topic 不会因为排过就凭空出现；
 *   - 没排过的 Topic 保持它们**彼此之间**的既有次序落在后面——新建一个 Topic 不该让它
 *     跳到某个不可预期的位置。
 */

/** 按用户顺序排列，未排过的按既有次序跟在后面。 */
export function orderTopics(
  topicIds: readonly string[],
  userOrder: readonly string[]
): string[] {
  if (userOrder.length === 0) return [...topicIds]
  const present = new Set(topicIds)
  // 偏好里已消失的 Topic 被丢掉：顺序是意图，不是真相来源。
  const ranked = userOrder.filter((id) => present.has(id))
  const rankedSet = new Set(ranked)
  return [...ranked, ...topicIds.filter((id) => !rankedSet.has(id))]
}

/**
 * 一次拖拽产生的新顺序。
 *
 * 输入的是**当前展示序**（即 `orderTopics` 的输出），输出可直接存回用户顺序——
 * 于是"拖到哪儿"和"存下什么"是同一件事，不需要第二次换算。
 */
export function reorderTopics(
  shown: readonly string[],
  movedId: string,
  targetId: string
): string[] {
  const from = shown.indexOf(movedId)
  const to = shown.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...shown]
  const next = [...shown]
  next.splice(from, 1)
  next.splice(to, 0, movedId)
  return next
}
