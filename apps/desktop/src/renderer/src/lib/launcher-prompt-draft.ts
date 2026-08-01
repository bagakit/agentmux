/**
 * 启动器 prompt 那一格的取值与写回口，一次判定。
 *
 * 与 {@link launcherNameBinding} 同源同理由：读与写各自算一次 key，就是同一个概念的两处判定，
 * 两处会漂移——而漂移的症状是**输入框静默不响应**（写进了 A 键，读的是 B 键，用户敲什么都看不见
 * 变化，且没有任何报错）。
 *
 * 名字那两格早已收成一处，prompt 当时没跟上，于是同一个文件里两种做法并存。实测这笔代价：把
 * 组件里写回那一处的 key 换成 `drift-${regionId}`（只改写侧），`launcher-draft-binding` +
 * `launcher-draft-survival` + `launch-naming` + `controlled-input-is-writable` 共 **18 条全绿**；
 * 同样漂移读侧则 `launcher-draft-binding` 有 1 条红。也就是说读侧有人守、写侧无人守。今天两处
 * 恰好都写 `regionId` 所以不坏，但只要有谁改动其中一处（浮动工作区就要引入新的归属作用域），
 * textarea 立刻静默变只读。
 *
 * 归属键是 launcher 的 `regionId`：启动的一瞬间这个 region 就被换成 pending agent surface、组件随即
 * 卸载，启动失败翻回 launcher（`reduceSessionLaunchFailed` 沿用同一 regionId）时要能把用户填的内容
 * 原样接回来。空分组占位没有 regionId，也就没有可跨卸载存活的稳定键，退回调用方给的本地取值——
 * 不造伪键污染共享表。
 *
 * 共享的那张表是 `agentComposerDrafts`，同时被 launcher（键为 region id）与 `AgentSessionComposer`
 * （键为 session id）使用。两族键天然不撞，但这也意味着**新增第三个使用者必须自带不与前两族碰撞的
 * 键**，而不是随手复用 region id 的拼法。
 */

export type LauncherPromptBinding = {
  prompt: string
  set(value: string): void
}

export function launcherPromptBinding(input: {
  /** launcher region 的 id；缺席即「没有稳定归属键」。 */
  regionId: string | undefined
  /**
   * 全量草稿表。索引发生在这个函数内部——这就是「只判一次 key」的落点。
   *
   * 传整张表而不是传「已经取好的那一条」：后者会把索引留在调用方，key 判定就又分了两处，
   * 这个模块也就白设了。缺省给空对象不给 undefined，好让缺席与空串两种情形在类型上不分岔。
   */
  drafts: Record<string, string>
  writeShared(regionId: string, value: string): void
  local: string
  writeLocal(value: string): void
}): LauncherPromptBinding {
  const { regionId } = input
  if (regionId === undefined) {
    return { prompt: input.local, set: (value) => input.writeLocal(value) }
  }
  return {
    prompt: input.drafts[regionId] ?? '',
    set: (value) => input.writeShared(regionId, value)
  }
}
