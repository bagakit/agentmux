import { guideSharedGoalCommon, guideSharedGoalContract, guideSharedGoalExecutor, guideSharedGoalManager } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
/** Canonical Goal responsibility contract shared by module, handbook and input producers. */
export const AGENTMUX_GOAL_SKILL_ENTRY = 'amux goal --skill'

export type GoalAgentRole = 'manager' | 'executor'

export interface GoalRoleGuidanceSource {
  kind: string
  operationId?: string
  messageId?: string
  sourceMessageId?: string
  threadId?: string
}

export interface GoalRoleGuidanceContext {
  role: GoalAgentRole
  goalId?: string
  agentSessionId?: string
  runId?: string
  source?: string | GoalRoleGuidanceSource
}

const shared = /* @__PURE__ */ guideText(guideSharedGoalCommon, { 'goal-skill-entry': AGENTMUX_GOAL_SKILL_ENTRY })

const executor = /* @__PURE__ */ guideText(guideSharedGoalExecutor)

const manager = /* @__PURE__ */ guideText(guideSharedGoalManager)

export function goalRoleGuidanceContract(): string {
  return guideText(guideSharedGoalContract, { 'goal-skill-entry': AGENTMUX_GOAL_SKILL_ENTRY })
}

/** Application-authored context; callers retain the original user text separately. */
export function goalRoleGuidance(context: GoalRoleGuidanceContext): string {
  const { role, ...identity } = context
  return `Goal role: ${role}\nKnown original context: ${JSON.stringify(identity)}\nRequired module: ${AGENTMUX_GOAL_SKILL_ENTRY}\n\n${shared}\n\n${role === 'manager' ? manager : executor}`
}
