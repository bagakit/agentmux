// Mutations of the real planning owners. Both standalone and local task proofs consume this one list.
export const goalPlanRequestMutations = [
  {
    "name": "new-plan-goes-to-discussion",
    "path": "apps/host/src/goal-discussions.ts",
    "anchor": "if (request.mode === 'plan') {",
    "replacement": "if (request.mode === 'plan' && false) {",
    "oracle": "a planning input reaches the Supervisor and only its saved public plan replaces the real empty Goal with the owner DAG"
  },
  {
    "name": "plan-missing-supervisor-guard-removed",
    "path": "apps/host/src/goal-patrol-owner.ts",
    "anchor": "if (purpose === 'plan' && !goal.supervisorSessionId) throw new AgentMuxError('This Goal has no Supervisor. Keep this planning request and choose a Supervisor in the original Goal relationships, then explicitly send it.', 'GOAL_PLAN_SUPERVISOR_REQUIRED')",
    "replacement": "",
    "oracle": "a planning request refuses missing management and self-request before any Goal or Core input changes"
  },
  {
    "name": "plan-missing-supervisor-refused-after-write",
    "path": "apps/host/src/goal-patrol-owner.ts",
    "edits": [
      {
        "anchor": "if (purpose === 'plan' && !goal.supervisorSessionId) throw new AgentMuxError('This Goal has no Supervisor. Keep this planning request and choose a Supervisor in the original Goal relationships, then explicitly send it.', 'GOAL_PLAN_SUPERVISOR_REQUIRED')",
        "replacement": ""
      },
      {
        "anchor": "    const saved = [...receipt.demand.patrols!]",
        "replacement": "    if (purpose === 'plan' && !goal.supervisorSessionId) throw new AgentMuxError('This Goal has no Supervisor. Keep this planning request and choose a Supervisor in the original Goal relationships, then explicitly send it.', 'GOAL_PLAN_SUPERVISOR_REQUIRED')\n    const saved = [...receipt.demand.patrols!]"
      }
    ],
    "oracle": "a planning request refuses missing management and self-request before any Goal or Core input changes"
  },
  {
    "name": "plan-self-request-guard-removed",
    "path": "apps/host/src/goal-patrol-owner.ts",
    "anchor": "if (purpose === 'plan' && authority.actor.kind === 'agent' && authority.actor.id === goal.supervisorSessionId && planningHost !== undefined && authority.hostId === planningHost) throw new AgentMuxError('You are this Goal’s Supervisor. Read goal plan and save through goal plan revise instead of requesting a plan from yourself.', 'GOAL_PLAN_REQUEST_SELF')",
    "replacement": "",
    "oracle": "a planning request refuses missing management and self-request before any Goal or Core input changes"
  },
  {
    "name": "old-planning-claim-redirected",
    "path": "apps/host/src/goal-discussions.ts",
    "anchor": "if (!retained && (frozen || claimed)) {",
    "replacement": "if (false && !retained && (frozen || claimed)) {",
    "oracle": "an old claimed discussion planning operation is only reconciled while a new operation uses the Supervisor"
  },
  {
    "name": "busy-planning-bypasses-preparation",
    "path": "apps/host/src/goal-patrol-owner.ts",
    "anchor": "decision = decideFutureProgress(observation, occurrence)",
    "replacement": "decision = patrol.purpose === 'plan' ? { kind: 'send' as const } : decideFutureProgress(observation, occurrence)",
    "oracle": "a busy Supervisor retains coalesced planning operations and native eligibility sends the original input once"
  },
  {
    "name": "planning-appears-in-patrol",
    "path": "apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx",
    "anchor": "demand.patrols?.filter(item => item.purpose !== 'plan').at(-1)",
    "replacement": "demand.patrols?.at(-1)",
    "oracle": "a planning input reaches the Supervisor and only its saved public plan replaces the real empty Goal with the owner DAG"
  },
  {
    "name": "planning-feedback-removed",
    "path": "apps/desktop/src/renderer/src/components/GoalPlanRequest.tsx",
    "anchor": "{observed ? <p className=\"goals-service\"",
    "replacement": "{false && observed ? <p className=\"goals-service\"",
    "oracle": "a planning input reaches the Supervisor and only its saved public plan replaces the real empty Goal with the owner DAG"
  },
  {
    "name": "planning-alias-lost",
    "path": "packages/demand/src/demand-store.ts",
    "anchor": "retained.requestOperationIds = [...retained.requestOperationIds ?? [], input.operationId]",
    "replacement": "retained.requestOperationIds = []",
    "oracle": "a busy Supervisor retains coalesced planning operations and native eligibility sends the original input once"
  }
]
