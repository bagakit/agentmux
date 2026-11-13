import { describe, expect, it } from 'vitest'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { goalRoleGuidance } from '../src/goal-role-guidance.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'

/**
 * Mote and executors learn the plan from the guidance they actually receive: the Goal module
 * skill, the manager and executor role guidance injected into their input, and the command help.
 */
describe('Goal plan guidance reaches its readers', () => {
  it('the Goal module skill explains plan read, revision, node delegation, review and monitoring', () => {
    const skill = agentMuxModuleSkill('goal')!
    for (const fact of ['goal plan --goal ID', 'goal plan revise', 'intent.planNodeId', 'goal plan review', 'someone other than its executor',
      'record the command, its actual result and evidence', 'same executor on the same', 'reconcile from the original', 'never accepts the Goal'])
      expect(skill, fact).toContain(fact)
  })

  it('the manager and executor role guidance point at the plan rules', () => {
    const manager = goalRoleGuidance({ role: 'manager', goalId: 'goal' })
    const executor = goalRoleGuidance({ role: 'executor', goalId: 'goal' })
    expect(manager).toContain('read goal plan first')
    expect(manager).toContain('independent goal plan review')
    expect(executor).toContain('planNodeId delivers that plan node')
    expect(executor).toContain('never review your own node')
    expect(manager).not.toContain('planNodeId delivers that plan node')
  })

  it('every plan command has help that names its owner rules', () => {
    for (const [method, fact] of [['goal.plan', 'Node state is derived'], ['goal.plan.revise', 'expectedRevision'], ['goal.plan.review', 'cannot review its own work']] as const) {
      const help = agentMuxCommandHelp(method)
      expect(help, method).toBeTruthy()
      expect(help, method).toContain(fact)
    }
  })
})
