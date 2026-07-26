/**
 * 按下保存快捷键的那一刻，到底该发生什么——判定层。
 *
 * 编辑器此前只有工具栏按钮一条保存通路，键盘上按不了保存。补快捷键时真正的问题不是"绑一个
 * 键"，而是**这个键在每种文件状态下各自意味着什么**：干净的文件按了不该重写一遍，正在保存
 * 时按了不该排第二次，而磁盘上已经变了的文件按了**绝不能**当作普通保存——那会悄悄覆盖别人
 * 的改动，是这里唯一不可逆的后果。
 *
 * 判定写成纯函数而不是塞进 Monaco 的回调里：本仓库测试用 `renderToStaticMarkup`，effect 不跑、
 * 键盘事件发不出去，写在回调里的分支没有断言够得着。与 `quick-switch-shortcut` 同构。
 */

/** 文件此刻处于哪种状态——只取判定需要的那几个事实，不接整个 store。 */
export type EditorSaveContext = {
  /** 有未保存的改动。 */
  dirty: boolean
  /** 已经有一次写盘在飞。 */
  saving: boolean
  /**
   * 当前的文件问题类别，没有问题时缺席。
   * `changed`/`deleted` 是磁盘与我们分叉了；`read-error`/`write-error` 是上一次操作没成。
   */
  issue?: 'changed' | 'deleted' | 'read-error' | 'write-error'
}

/**
 * 快捷键此刻的落点。
 *
 * `conflict` 单独一类而不是并进 `none`：两者都不写盘，但**原因完全不同**，而这个区别决定了
 * 用户下一步该做什么。分叉时按保存不能装作无事发生。
 */
export type EditorSaveAction =
  /** 写盘。 */
  | 'save'
  /** 磁盘已分叉，必须由用户在 Reload 与 Overwrite 之间选，快捷键不替他选。 */
  | 'conflict'
  /** 没有可保存的东西（干净、或正在保存）。 */
  | 'none'

/**
 * 保存快捷键此刻该做什么。
 *
 * **`changed`/`deleted` 绝不自动 Overwrite**——覆盖是这条通路上唯一不可逆的动作，而快捷键是
 * 最容易被下意识按下的入口。用户在别处改了这个文件，然后习惯性按下保存，就把别人的改动无声
 * 冲掉了；这正是「不可逆的事要先确认」在这里的具体含义。所以分叉时返回 `conflict`，把选择留
 * 在已经显示出来的那两个按钮上。
 *
 * `write-error` 反过来**允许再按**：上一次没写成，重试是正确且可逆的动作，这时把键堵死等于
 * 让用户只能去点按钮。`read-error` 归入不可保存——刷新都没成功，此刻的 revision 不可信。
 */
export function editorSaveAction(context: EditorSaveContext): EditorSaveAction {
  if (context.issue === 'changed' || context.issue === 'deleted') return 'conflict'
  if (context.saving) return 'none'
  if (context.issue === 'read-error') return 'none'
  return context.dirty ? 'save' : 'none'
}
