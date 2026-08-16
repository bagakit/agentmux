/**
 * 「显示崩溃日志」点下去之后该说什么。
 *
 * 三个结局，因为**两个不够**：文件不存在是「没崩过」——好消息，必须说出来；什么都不说的话，用户分不清
 * 是没崩过还是按钮坏了。这正是这条功能存在理由的镜像：崩溃证据一直在写（crash-log.ts 的 NDJSON），
 * 却从来没有读者，于是「在写」和「没在写」对用户是同一个样子。修复不能把那个病原样搬进来。
 *
 * 单独成模块而不是留在 pane 里：pane 经 `lib/api` 摸到一个构建期常量（`__AGENTMUX_WEB_PREVIEW__`），
 * 测试一 import 就在加载期炸——而这段判定是纯的，本来就不该被那条依赖链拖着走。
 */
export type CrashLogReveal = 'idle' | 'revealed' | 'absent' | 'failed'

/** 每个结局配一句人话，未点击时沉默。四个分支都必须有确定的答案——沉默是这条功能本来要修的那个病。 */
export function crashLogRevealNotice(state: CrashLogReveal): string | null {
  if (state === 'idle') return null
  if (state === 'revealed') return 'Opened in your file manager.'
  if (state === 'absent') return 'No crashes recorded — the log has never been written.'
  return 'Could not open the log. It lives in the app support folder.'
}
