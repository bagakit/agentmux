import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Demand } from './demand-types.js'
import { projectGoalPlan, type GoalPlanNodeState, type GoalPlanUnknownReason } from './goal-plan.js'
import { goalPlanWorkRoles, type GoalPlanWorkRole } from './relations.js'
import type { GoalPlanPredecessor } from './delegations.js'

export type GoalActiveNode = {
  nodeId: string
  title: string
  state: Exclude<GoalPlanNodeState, 'done' | 'cancelled' | 'waiting'>
  attemptOperationId?: string
  unknown: GoalPlanUnknownReason[]
  predecessors: GoalPlanPredecessor[] | null
  claim?: { openingOperationId: string; basis: string }
}
export type GoalActivePlan = {
  role?: GoalPlanWorkRole
  goalId: string
  goalUpdatedAt: number
  nodes: GoalActiveNode[]
}

function activePlan(goal: Demand): GoalActivePlan | null {
  if (!goal.plan || goal.status === 'done' || goal.status === 'cancelled') return null
  const plan = goal.plan
  const projection = projectGoalPlan(plan, goal.delegations ?? [], goal.alignment?.criteria ?? [], undefined, goal.alignment?.revision)
  const nodes = projection.nodes.flatMap(({ node, state, unknown, predecessors, delegation, claimBasis, claimOpeningOperationId }): GoalActiveNode[] => {
    if (state === 'done' || state === 'cancelled' || state === 'waiting') return []
    return [{ nodeId: node.id, title: node.title, state, unknown, predecessors,
      ...(delegation ? { attemptOperationId: delegation.operationId } : {}),
      ...(claimBasis && claimOpeningOperationId ? { claim: { openingOperationId: claimOpeningOperationId, basis: claimBasis } } : {}) }]
  })
  return nodes.length ? { goalId: goal.id, goalUpdatedAt: goal.updatedAt, nodes } : null
}

/** Only a projection of the original snapshot. A generation is published in the same transaction as its rows. */
export class GoalActiveIndex {
  constructor(private readonly path: string) {}

  read(generation: string, target: { goalId?: string; agentSessionId?: string }): GoalActivePlan[] | null {
    const db = new DatabaseSync(this.path, { readOnly: true })
    try {
      db.exec('BEGIN')
      const valid = db.prepare('SELECT 1 FROM active_generation WHERE snapshot = ?').get(generation)
      if (!valid) return null
      const rows = target.agentSessionId !== undefined
        ? target.goalId === undefined
          ? db.prepare('SELECT g.content, m.role FROM active_member m JOIN active_goal g ON g.id = m.goal_id WHERE m.agent_session_id = ? ORDER BY m.goal_id').all(target.agentSessionId)
          : db.prepare('SELECT g.content, m.role FROM active_member m JOIN active_goal g ON g.id = m.goal_id WHERE m.agent_session_id = ? AND m.goal_id = ?').all(target.agentSessionId, target.goalId)
        : db.prepare('SELECT content FROM active_goal WHERE id = ?').all(target.goalId!)
      return rows.map(row => ({ ...JSON.parse(String(row.content)) as GoalActivePlan,
        ...(typeof row.role === 'string' ? { role: JSON.parse(row.role) as GoalPlanWorkRole } : {}) }))
    } finally { db.close() }
  }

  publish(generation: string, priorGeneration: string | null, changed: { id: string; goal: Demand | null } | null, all: () => readonly Demand[]): void {
    closeSync(openSync(this.path, 'a', 0o600))
    const db = new DatabaseSync(this.path)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS active_generation (snapshot TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS active_goal (id TEXT PRIMARY KEY, content TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS active_member (agent_session_id TEXT NOT NULL, goal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (agent_session_id, goal_id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS active_members_for_goal ON active_member (goal_id);
        BEGIN IMMEDIATE;
      `)
      const valid = priorGeneration !== null && db.prepare('SELECT 1 FROM active_generation WHERE snapshot = ?').get(priorGeneration)
      if (valid && changed) {
        db.prepare('DELETE FROM active_member WHERE goal_id = ?').run(changed.id)
        db.prepare('DELETE FROM active_goal WHERE id = ?').run(changed.id)
        if (changed.goal) this.write(db, changed.goal)
      } else {
        db.exec('DELETE FROM active_member; DELETE FROM active_goal;')
        for (const goal of all()) this.write(db, goal)
      }
      db.exec('DELETE FROM active_generation')
      db.prepare('INSERT INTO active_generation (snapshot) VALUES (?)').run(generation)
      db.exec('COMMIT')
    } finally { db.close() }
  }

  private write(db: DatabaseSync, goal: Demand): void {
    const content = activePlan(goal)
    if (!content) return
    db.prepare('INSERT INTO active_goal (id, content) VALUES (?, ?)').run(goal.id, JSON.stringify(content))
    const insert = db.prepare('INSERT INTO active_member (agent_session_id, goal_id, role) VALUES (?, ?, ?)')
    for (const [member, role] of goalPlanWorkRoles(goal)) insert.run(member, goal.id, JSON.stringify(role))
  }
}
