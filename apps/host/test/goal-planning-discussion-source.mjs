import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { repositoryRoot } from './goal-cross-host-source.mjs'

export const planningOwners = ['apps/host/src/goal-discussions.ts', 'packages/demand/src/discussion.ts',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'packages/core/src/goal-role-guidance.ts', 'packages/core/src/generated/agentmux-guides.ts']
export const planningMutations = {
  'planning-body': { path: 'apps/host/src/goal-discussions.ts',
    anchor: '`Make and save a dependency plan inside the existing Goal ${goal.id}.`',
    replacement: '`Inspect the existing Goal ${goal.id}.`' },
  'planning-navigation': { path: 'apps/host/src/goal-discussions.ts',
    anchor: "if (request.mode !== 'open' && request.requestId !== original?.requestOperationId)",
    replacement: "if (request.mode !== 'open' && request.mode !== 'plan' && request.requestId !== original?.requestOperationId)" },
  'planning-reconcile': { path: 'apps/host/src/goal-discussions.ts',
    anchor: 'if (!prior) {', replacement: "if (!prior || request.mode === 'plan') {" }
}
export function instrumentPlanningSource(source, absolutePath, consumer) {
  const path = relative(repositoryRoot, absolutePath)
  if (!planningOwners.includes(path)) return source
  const digest = value => createHash('sha256').update(value).digest('hex')
  const originalSHA256 = digest(source), mutant = process.env.GOAL_PLANNING_MUTANT
  if (mutant) {
    if (!Object.hasOwn(planningMutations, mutant)) throw Error('Select an exact planning mutation')
    const change = planningMutations[mutant]
    if (path === change.path) {
      if (source.split(change.anchor).length !== 2) throw Error('Planning mutation needs one exact owner anchor: ' + mutant)
      source = source.replace(change.anchor, change.replacement)
    }
  }
  const loadedSHA256 = digest(source), report = process.env.GOAL_PLANNING_LOADED
  if (!report) return source
  const receipt = { path, consumer, pid: process.pid, originalSHA256, loadedSHA256, ...(originalSHA256 === loadedSHA256 ? {} : { mutant }) }
  const header = "import { appendFileSync as __goalPlanningLoaded } from 'node:fs'; __goalPlanningLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n'
  const shebang = source.match(/^#![^\n]*\n/u)?.[0] ?? ''
  return shebang + header + source.slice(shebang.length)
}
