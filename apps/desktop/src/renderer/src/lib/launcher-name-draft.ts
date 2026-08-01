/**
 * 启动对话框那两格名字（Agent 名 / Tab 名）的取值与写回口，一次判定。
 *
 * 为什么要有这个模块，而不是在组件里直接读一下写一下：读与写各自算一次 key，就是同一个概念的两处
 * 判定，两处会漂移——而漂移的症状是**输入框静默不响应**（写进了 A 键，读的是 B 键，用户敲什么都
 * 看不见变化，且没有任何报错）。实测：把组件里写回那一处的 key 从 `regionId` 换成 `tabId ?? regionId`，
 * 那一版的 14 条测试**全绿**。所以这里把 key 判定收成一处，让"读写用同一个 key"没有可漂移的余地，
 * 并且做成一个可以被测试真正执行的纯函数——组件里剩下的只是把它接上去。
 *
 * 归属键是 launcher 的 `regionId`：启动的一瞬间这个 region 就被换成 pending agent surface、组件随即
 * 卸载，启动失败翻回 launcher（reduceSessionLaunchFailed 沿用同一 regionId）时要能把用户填的名字
 * 原样接回来。空分组占位没有 regionId，也就没有可跨卸载存活的稳定键，退回调用方给的本地取值。
 */

export type LauncherNames = { agentName: string; tabName: string }
export type LauncherNameField = keyof LauncherNames

export const EMPTY_LAUNCHER_NAMES: LauncherNames = { agentName: '', tabName: '' }

export type LauncherNameBinding = {
  names: LauncherNames
  set(field: LauncherNameField, value: string): void
}

export function launcherNameBinding(input: {
  /** launcher region 的 id；缺席即"没有稳定归属键"。 */
  regionId: string | undefined
  /** 全量草稿表。索引发生在这个函数内部——这就是"只判一次 key"的落点。 */
  drafts: Record<string, LauncherNames>
  writeShared(regionId: string, field: LauncherNameField, value: string): void
  local: LauncherNames
  writeLocal(field: LauncherNameField, value: string): void
}): LauncherNameBinding {
  const { regionId } = input
  if (regionId === undefined) {
    return { names: input.local, set: (field, value) => input.writeLocal(field, value) }
  }
  return {
    names: input.drafts[regionId] ?? EMPTY_LAUNCHER_NAMES,
    set: (field, value) => input.writeShared(regionId, field, value)
  }
}
