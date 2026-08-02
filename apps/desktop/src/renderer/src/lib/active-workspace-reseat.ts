import { isScratchWorkspaceId, type AppConfig } from '../../../shared/contracts'

/**
 * `activeWorkspaceId` 是**指进** `config.workspaces` 的一个引用。任何让某条记录消失的写入都必须
 * 同时回答「那现在活动的是哪一个」，否则活动位指着一个已经不存在的 id，而后果不是"漏一点状态"：
 * `App.tsx` 按它找 Workspace 得到 undefined，于是在别的项目和 Scratch 都还在的情况下渲染出
 * 「Bring a workspace」欢迎页；Board 那侧 project/anchor 一起变空。屏幕上没有任何一句话解释刚才
 * 发生了什么，用户会以为自己的项目也一起没了。
 *
 * 为什么必须收成**一个**函数：这个判断此前有两份各自的答案——启动恢复那份挑 `workspaces[0]`，
 * 侧栏删项目那份挑 Scratch。它们不是同一个答案的两种写法，而是**真的落到不同的 Workspace**：
 * Scratch 由 config-store 追加在末尾，所以 `workspaces[0]` 除非只剩它自己，否则永远不是 Scratch。
 * 一个问题两个答案必然漂移，症状是「同样删掉活动项目，从这里删和从那里删落到不同地方」。
 *
 * 候选是**有序的**，因为不同的删除现场对「接下来该看哪儿」有各自更好的答案，而那不该靠各自
 * 重新发明一遍兜底规则：扇出收尾时胜者就是答案，普通删除时没有比 Scratch 更中立的落点。所以调用方
 * 只声明自己的偏好次序，兜底规则仍然只有这里一份。
 *
 * 顺序及其理由：
 * 1. **候选里第一个还在的**。删掉的不是活动的那个时，活动位一动都不该动——挪走会让用户以为自己
 *    点错了。后续候选是调用现场的偏好（例如扇出的胜者）。
 * 2. **Scratch**。它是常在的「没有项目」落点，语义上就是"你现在不在任何项目里"。挑
 *    `workspaces[0]` 会把用户丢进一个他没选的项目，而那个项目恰好排在第一位纯属偶然。
 * 3. **第一条记录**。没有 Scratch 的配置（老配置、测试 fixture）仍要给出一个落点。
 * 4. **一条都没有就是 null**。空配置下装作有活动 Workspace 会把「空」这个事实藏起来。
 */
export function reseatActiveWorkspaceId(
  config: AppConfig,
  ...candidates: readonly unknown[]
): string | null {
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      config.workspaces.some((workspace) => workspace.id === candidate)
    ) return candidate
  }
  const scratch = config.workspaces.find((workspace) => isScratchWorkspaceId(workspace.id))
  return scratch?.id ?? config.workspaces[0]?.id ?? null
}

/**
 * 接下一份权威配置时该写进 store 的那一小块。
 *
 * 两个字段必须**同一次**算出来。分两处写（先 `set({ config })`，回头再想起来挪活动位）就是这一族
 * 缺陷本身：中间那一瞬 store 自相矛盾，任何在其间跑的 selector 都会读到一个指向不存在记录的活动位。
 * 返回一份补丁而不是两个动作，是为了让「写 config」这件事在类型上就带着「活动位怎么办」的答案——
 * 下一个人加第三个写入点时抄的是这个函数，而不是重新发明一次落点规则。
 */
export function adoptedConfig(
  active: string | null,
  config: AppConfig,
  ...preferred: readonly unknown[]
): { config: AppConfig; activeWorkspaceId: string | null } {
  return { config, activeWorkspaceId: reseatActiveWorkspaceId(config, active, ...preferred) }
}
