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

const shared = `Read ${AGENTMUX_GOAL_SKILL_ENTRY} before working on or managing a Goal; use amux goal --help
for this version's exact operations and arguments. The original Goal owner holds accepted
scope, criteria, execution bindings, progress, reports and business state. Core owns the
authenticated Session, exact Run, original input and delivery facts; ctxmux owns process state.
Keep the original Goal, alignment revision, execution operation, Host, Session, Run and source
message/thread identities. Assignees, titles, an open view and displayed status are not execution proof.
Do not replace an original Goal or Session to repair an unknown observation. Unknown/stale/
unavailable facts remain visible; inspect the original request and input before another write.
Never blindly resend unknown or partial input, and retain the healthy Agent's input and work surface.
An execution authorization does not confirm Goal alignment or accept results for the person.
Idle, exit, delivery, acknowledgement, worker_done and Tracker archival do not complete a Goal.`

const executor = `Bind work to the exact finite Start or original delegation and its selected criteria.
Inspect the original Goal and source before implementation; a discussion or patrol request
alone does not authorize execution. Keep progress, evidence, gaps and unknowns in the same Goal.
Report a blocker or question through the original source/thread and retain responsibility
until an explicit verified handoff. Use the current Goal progress operation for a concrete
next action; external waiting names the condition, evidence and resume condition. A waiting,
review or handoff declaration does not itself discharge execution responsibility.
Return delivery evidence for every delegated criterion through the original Goal report and
dispatch; preserve the actual reporting Run. Give the manager the next action and evidence
needed to verify or collect it. A temporary idle turn or healthy background Run is not failure.
Do not claim another person's confirmation, acceptance or a live model's adoption of updated guidance.`

const manager = `Inspect original execution bindings and authoritative Session/Run/input facts, not an
assignee list or presentation label. Distinguish short idle, healthy background execution,
native input waiting, declared external waiting, pending review and unreported stalled work.
Verify workers' evidence, gaps and unknowns before collecting reports into the same Goal.
Explicitly associate a verified result with its exact execution; an unrelated Goal result
does not discharge other workers. Write the actual progress, business state, evidence/gaps/
unknowns, next responsible party and next action back to the original Goal. Keep human
alignment confirmation and result acceptance with the person.
Handle actionable idle, failure or exit without an accounted handoff. A patrol click, queued
input, delivery acknowledgement or reminder is not a completed inspection. For an original
patrol, read its frozen Goal/execution/source and original input, perform the inspection, then
submit the real inspection report and business writeback to that same Goal. Only resulting
business facts can change the responsibility alert. Preserve a late report as history when
its frozen scope no longer matches; do not overwrite newer work.
If management is busy, missing, exited or on a different Run, retain the original request and
show the exact inspect, selection or same-Session recovery action. Resume only through an
explicit supported continuation with proven original input state; never silently replace the
manager or retry uncertain input. Recovery/navigation and actual patrol completion are distinct.`

export function goalRoleGuidanceContract(): string {
  return `${shared}\n\n## Executor responsibilities\n\n${executor}\n\n## Management responsibilities\n\n${manager}`
}

/** Application-authored context; callers retain the original user text separately. */
export function goalRoleGuidance(context: GoalRoleGuidanceContext): string {
  const { role, ...identity } = context
  return `Goal role: ${role}\nKnown original context: ${JSON.stringify(identity)}\nRequired module: ${AGENTMUX_GOAL_SKILL_ENTRY}\n\n${shared}\n\n${role === 'manager' ? manager : executor}`
}
