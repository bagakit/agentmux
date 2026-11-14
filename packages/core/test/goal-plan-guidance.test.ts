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
    const skill = agentMuxModuleSkill('goal')!.replace(/\s+/gu, ' ')
    for (const fact of ['goal plan --goal ID', 'goal plan revise', 'intent.planNodeId', 'goal plan review', 'someone other than its executor',
      'record the command, its actual result and evidence', 'same executor on the same', 'never accepts the Goal',
      'complete node criterion set', 'cancel it and add a', 'unchanged criteria keep their accepted work',
      'planState carries that derivation', 'instead of deriving state yourself', 'Goal records carry the same planState with their plan',
      'Without planState the owner gave no derivation: node states are unknown to you',
      'dispatch-link: read the original delegation receipt before acting and never resend that delivery',
      'criteria: the node names no criterion, names one the current proposal no longer has, or one whose text changed since its attempt was sent'])
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

  it('source reports and receipts reach the actual module and executor guidance', () => {
    const skill = agentMuxModuleSkill('goal')!, executor = goalRoleGuidance({ role: 'executor', goalId: 'goal' })
    for (const fact of ['sourceMessageId', 'report-submission', 'outbox', 'do not create a duplicate Goal store', 'envelope.application'])
      expect(executor, fact).toContain(fact)
    for (const fact of ['intent.workerHostId', 'Runtime and', 'original signed replies']) expect(skill, fact).toContain(fact)
    expect(agentMuxCommandHelp('goal.report')).toContain('sourceMessageId')
  })

  it('every plan command has help that names its owner rules', () => {
    for (const [method, fact] of [['goal.plan', 'Node state is derived'], ['goal.plan', 'planState is the owner\'s derivation'], ['goal.plan', 'criteria (the node names no criterion'],
      ['goal.plan', 'dispatch-link (the attempt was prepared'], ['goal.plan', 'Without planState the owner gave no derivation: node states are unknown to this reader'],
      ['goal.plan.revise', 'expectedRevision'], ['goal.plan.review', 'cannot review its own work']] as const) {
      const help = agentMuxCommandHelp(method)
      expect(help, method).toBeTruthy()
      expect(help, method).toContain(fact)
    }
  })

  it('discovers an explicit planning request without treating discussion or confirmation as plan authority', () => {
    const skill = agentMuxModuleSkill('goal')!, manager = goalRoleGuidance({ role: 'manager', goalId: 'goal' })
    for (const fact of ['--mode plan', 'human confirmation is not a prerequisite', 'discussion Agent is not automatically the Supervisor', 'acknowledgement or a textual breakdown'])
      expect(skill, fact).toContain(fact)
    expect(manager).toContain('When explicitly asked to plan')
    expect(manager).toContain('manager guidance is not a Supervisor grant')
    const help = agentMuxCommandHelp('goal.discuss')!
    for (const fact of ['open|grill|grounding|plan', '--operation-id', 'input, not a saved plan', 'never starts work']) expect(help, fact).toContain(fact)
  })
})
