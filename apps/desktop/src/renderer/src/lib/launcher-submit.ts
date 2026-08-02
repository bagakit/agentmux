// 起点页「现在能不能启动」只判一次，以及「这次按键是不是要启动」。
//
// 为什么要有这个文件，而不是让 keydown 处理器自己写一遍条件：主按钮的 `disabled` 与键盘那条路问的是
// **同一个问题**。手抄两份的漂移症状不是报错，而是两条路对同一概念判得不一样——按钮灰着而 Cmd+Enter
// 照旧发车（没有 workspace 时启动、或者 busy 期间再启动一次），或者反过来按钮能点而键盘死掉。本仓
// 「读的 key 与写的 key 必须只判一次」「两条路对同一概念判得不一样先假定有 bug」两条教训是同一形状。
//
// 为什么连「这次按键要不要启动」也收进来：这样组件里的 keydown 壳里没有任何判断语句，只有一次转发 +
// preventDefault。壳里有条件时，那个条件就是无人守的第二处判定（本仓「抽进 lib 只解决一半」）。

import { matchShortcut, type ShortcutEvent } from './shortcut-registry'

/** 启动一个 Agent 需要成立的三件事，取自组件里已有的三个取值，不在这里重新取。 */
export interface LauncherReadiness {
  /** 卡片标题里那个 Workspace 解析出来了吗（没有就没有落点）。 */
  hasWorkspace: boolean
  /** 五个动作里已经有一个在飞（组件里是 `busy !== null`）。 */
  busy: boolean
  /** 这台 host 上装好了几个 Agent；一个都没有时启动必然失败。 */
  installedExecutorCount: number
}

/**
 * 现在能不能启动。主按钮的 disabled 与键盘那条路共用这一次判定。
 *
 * 注意三条都是必要条件而不是「或」：任一不成立时 `launchAgent` 要么没有落点、要么会撞上在飞的那次、
 * 要么挑不出 executor。三条里少判一条的症状都是「点下去报一个内部错」而不是被拦住。
 */
export function launcherCanLaunch(readiness: LauncherReadiness): boolean {
  return readiness.hasWorkspace && !readiness.busy && readiness.installedExecutorCount > 0
}

/**
 * 这次 keydown 是不是「立刻启动」。是注册表匹配**与**上面那道闸的合取。
 *
 * 返回 false 时调用方不该 preventDefault：那一下不属于我们，textarea 该拿回它自己的默认行为。
 * 闸关着时也返回 false——按了没反应，与按钮灰着一致；绝不能变成「键盘绕过 disabled」。
 */
export function launcherKeydownLaunches(
  event: ShortcutEvent,
  isMac: boolean,
  readiness: LauncherReadiness
): boolean {
  if (matchShortcut(event, isMac, { scope: 'launcher' }) !== 'launcher.submit') return false
  return launcherCanLaunch(readiness)
}
