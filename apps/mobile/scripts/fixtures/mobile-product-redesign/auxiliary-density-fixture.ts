import type { AgentMuxAgentSession, AgentTimelineItem } from '@agentmux/core'
import { normalizeAgentTimelineItem } from '../../../../../packages/core/src/session-timeline'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'

/** Typed external history only; the actual Core projection decides record roles/order. */
export function auxiliaryDensityTimeline(session: AgentMuxAgentSession): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [0, 1, 2].flatMap(group => {
    const at = fixtureEpoch(0, group + 1), prefix = `auxiliary-${group + 1}`
    const common = { agentSessionId: session.agentSessionId, source: 'native-hook' as const, status: 'complete' as const, createdAt: at, updatedAt: at }
    return [
      ...[0, 1].map(step => ({ ...common, id: `${prefix}-tool-${step + 1}`, kind: 'tool_call' as const,
        title: `核对第 ${group + 1} 组原材料`, toolName: 'Read', status: group === 1 && step === 1 ? 'failed' as const : 'complete' as const, toolInput: JSON.stringify({ path: `original/group-${group + 1}-${step + 1}.md` }),
        toolOutput: `第 ${group + 1} 组原工具输出，完整依据未删。`, createdAt: at + step, updatedAt: at + step })),
      { ...common, id: `${prefix}-snapshot`, kind: 'assistant_message' as const, title: 'Original captured reply',
        eventName: 'native.reply', content: `第 ${group + 1} 组已核对：保留原文和准确来源。\n\n完整原文段落 ${group + 1}：当前只是采集到的回复快照，不能当作身份或任务完成证明。`, createdAt: at + 2, updatedAt: at + 2 },
      { ...common, id: `${prefix}-input`, kind: 'user_message' as const, source: 'user' as const, authorHuman: true,
        title: 'Original saved input', content: `请继续第 ${group + 1} 组原问题，保留资料、草稿和未知回执。`, publicContent: 'confirmed' as const,
        inputRef: { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: `${prefix}-submission` },
        inputOrigin: { queueId: 'auxiliary-original-journal', incarnation: 'auxiliary-original-incarnation', sequence: group + 1 },
        inputSubmission: { status: 'terminal-confirmed' as const, observation: 'owned' as const }, createdAt: at + 3, updatedAt: at + 3 }
    ]
  })
  return items.map(item => normalizeAgentTimelineItem(item))
}
