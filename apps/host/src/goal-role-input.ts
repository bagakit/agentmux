import { goalRoleGuidance, type GoalRoleGuidanceContext } from '@agentmux/core/goal-role-guidance'
import type { AgentPromptSubmissionRecord } from '@agentmux/core'

/** An existing Core claim keeps its actual source, including an absent original system segment. */
export function goalRoleInputNote(note: string | undefined, role: GoalRoleGuidanceContext, original: AgentPromptSubmissionRecord | null): string | undefined {
  if (original) return original.admission?.intent?.message?.systemContext
  return [note, goalRoleGuidance(role)].filter(Boolean).join('\n\n')
}
