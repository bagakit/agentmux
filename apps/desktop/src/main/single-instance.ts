/**
 * 双开守卫的纯决策逻辑。启动路径上的 electron API 在测试环境跑不起来，所以「拿不到锁该做什么」和
 * 「第二实例来敲门时该把窗口怎么带到前台」这两个决策抽成纯函数，index.ts 只做接线。
 *
 * 为什么要守：全仓原本没有 requestSingleInstanceLock。用户双击应用图标是必然场景，两个实例会各自
 * 构造 RuntimeController、各自 spawn/adopt daemon，在会话存储和运行时状态目录上互相踩。会话存储内部
 * 的跨进程 PID 锁只缩小了爆炸半径（写入不交错），没有阻止两个运行时互抢——守要守在启动处，在任何
 * 运行时/daemon 引导之前。
 */

/**
 * 拿到/没拿到单实例锁之后，这个实例该扮演什么角色。
 * - primary：我们是唯一实例，照常引导运行时。
 * - secondary：已经有实例在跑，我们立刻退出，把「带窗口到前台」交给已在运行的主实例。
 *
 * 退出走 `app.quit()`（默认退出码 0）：第二实例退出是预期行为（用户又点了一下图标），不是错误。
 * 这里只做角色判别，不携带退出码——退出码是接线层 quit 的语义，塞进纯数据里没有任何消费者。
 */
export type InstanceRole =
  | { role: 'primary' }
  | { role: 'secondary' }

export function instanceRoleFromLock(gotLock: boolean): InstanceRole {
  return gotLock ? { role: 'primary' } : { role: 'secondary' }
}

/** 已有窗口的当前状态，决定要用哪几步把它带到用户眼前。 */
export type ExistingWindowState = {
  exists: boolean
  minimized: boolean
}

/**
 * 第二实例来敲门时，主实例该对已有窗口做哪几步。顺序有意义：先 restore（最小化的要先还原，否则
 * focus 一个最小化窗口用户还是看不见），再 focus（把它抬到最前并拿到焦点）。
 *
 * 关键约束：绝不能是空动作。第二实例已经为用户「又点了一次」，如果主实例什么都不做，用户会以为
 * 点了没反应。没有窗口（比如 macOS 上全关了但 app 还活着）时返回 ['create']，让接线层新开一个。
 */
export function foregroundActionsForSecondInstance(state: ExistingWindowState): string[] {
  if (!state.exists) return ['create']
  const actions: string[] = []
  if (state.minimized) actions.push('restore')
  actions.push('focus')
  return actions
}
