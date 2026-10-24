import { createHash } from 'node:crypto'
const admission = "const admission = await options.spatial.admitAgentOpen({ request, agentSessionId, execution, regionResource: regionDescriptor({ agentSessionId, execution }, 'launching') })"
const platform = 'const platformContext = await options.agentMuxContext?.(request)'
const authority = 'context.signal?.throwIfAborted(); await context.assertCurrent?.()'
export const goalMutations = {
  'progress-activation-authority': ['apps/host/src/continuous-progress-loop-manager.ts', "if (context.caller || !context.principal || !['user','device'].includes(context.principal.kind))", 'if (false)'],
  'discussion-before-admission': ['apps/host/src/spatial-agent-control.ts', platform + '\n    ' + authority + '\n    ' + admission, admission + '\n    ' + platform + '\n    ' + authority],
  'participation-owner': ['apps/host/src/host.ts', 'goalParticipation: goals.participation,', 'goalParticipation: undefined,'],
  'goal-host-owner': ['apps/host/src/host.ts', 'goalControl: goals.execute,', 'goalControl: undefined,'],
  'continuation-input': ['apps/host/src/goal-runtime.ts', 'if (automation && !automation.isCurrent())', 'if (automation) return; if (automation && !automation.isCurrent())'],
  'discussion-message-producer': ['apps/host/src/goal-discussions.ts', "await options.call('agent.send', {", "if (false) await options.call('agent.send', {"],
  'discussion-platform-validation': ['apps/host/src/goal-discussions.ts', 'if (!frozenRequestMatches)', 'if (false && !frozenRequestMatches)'],
  'explicit-pause': ['apps/host/src/goal-automation-pause.ts', "loop.status !== 'stopped')", "loop.status === 'never-active')"]
}
const observed = new Set(['apps/host/src/host.ts', 'apps/host/src/goals.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-manager.ts', 'apps/host/src/goal-automation-pause.ts', 'apps/desktop/src/main/desktop-goals.ts', 'apps/host/src/goal-discussions.ts', 'apps/host/src/spatial-agent-control.ts', 'apps/host/src/goal-participation-owner.ts', 'packages/core/src/agent-progress.ts', 'packages/core/src/goal-participation.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/client.ts', 'packages/demand/dist/src/demand-store.js', 'packages/demand/dist/src/discussion.js'])
export function instrumentGoalsSource(source, path, surface) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.MOBILE_GOALS_TEST_MUTANT
  if (mutant && !Object.hasOwn(goalMutations, mutant)) throw Error('Unknown Goal implementation mutation')
  if (mutant && goalMutations[mutant][0] === path) {
    const [, anchor, replacement] = goalMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Goal mutation requires one exact implementation anchor')
    source = source.replace(anchor, replacement)
  }
  const report = process.env.MOBILE_GOALS_TEST_LOADED
  if (report) {
    const hash = text => createHash('sha256').update(text).digest('hex')
    const receipt = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __goalEvaluated } from 'node:fs'; __goalEvaluated(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
