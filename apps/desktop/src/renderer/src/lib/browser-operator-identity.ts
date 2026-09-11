import type { SessionSnapshot } from '../../../shared/contracts'
import type { BrowserOperator } from '../../../shared/browser-operation'

/**
 * 谁在操作这个浏览器——从真实的 Session 事实解析，而不是拿 id 拼一个名字出来。
 *
 * 为什么需要这一层：调用点原先写的是 `{ id, name: \`Agent ${agentSessionId}\` }`——一个
 * 拼出来的名字（"Agent 7f3a9c2e-…"）加上**永远缺席的 providerId**。轨迹上于是显示一串 UUID，
 * 头像退化成通用图标，而"是哪个 Agent 在动我的浏览器"正是这条轨迹要回答的**唯一**问题。
 *
 * 真实身份就在同一个作用域里（renderer 持有 sessions 投影），所以这不是"缺数据"，是缺这一次解析。
 *
 * 缺席时**不编造**：Session 找不到（已退休、跨 Host、或根本没有 caller）时，退回 id 本身并让
 * providerId 缺席，而不是拼一个看起来像真名的字符串。一个显示 id 的轨迹条会让人去查这是谁；
 * 一个显示 "Agent 7f3a9c2e" 的轨迹条会让人以为那就是它的名字。
 */
export function browserOperatorForSession(
  agentSessionId: string,
  sessions: readonly SessionSnapshot[]
): BrowserOperator {
  const session = sessions.find((candidate) => candidate.id === agentSessionId)
  if (!session || session.kind !== 'agent') return { id: agentSessionId, name: agentSessionId }
  return {
    id: agentSessionId,
    name: session.label,
    // 条件展开而不是 `providerId: session.providerId`：这个字段是可选的，写成必给会在
    // 值为 undefined 时留下一个"在场但为空"的键，而下游 `providerId ? <Icon/> : null`
    // 两种写法看起来都对——直到有人改成 `'providerId' in operator`。
    ...(session.providerId ? { providerId: session.providerId } : {})
  }
}
