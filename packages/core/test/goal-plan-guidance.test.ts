import { describe, expect, it } from 'vitest'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { goalRoleGuidance } from '../src/goal-role-guidance.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'

const prose = (value: string) => value.replace(/\s+/gu, ' ')

describe('Goal plan guidance reaches its readers', () => {
  it('puts plan, delivery and review before the ancillary operations', () => {
    const skill = prose(agentMuxModuleSkill('goal')!)
    const journey = ['goal plan --goal ID', 'intent.planNodeId', 'goal plan review --input FILE', 'saved review operation, node and delegation']
    const positions = journey.map(step => skill.indexOf(step))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.at(-1)).toBeLessThan(skill.indexOf('## Assign or start work'))
    expect(skill).toContain('View delivery → Record review')
    expect(skill).toContain('Node states stay unknown while the derivation is unavailable')
    expect(skill).toContain('A dependent task becomes ready once all its dependencies pass')
  })

  it('the manager can delegate rework on the original thread and the executor reports its actual evidence', () => {
    const manager = prose(goalRoleGuidance({ role: 'manager', goalId: 'goal' }))
    const executor = prose(goalRoleGuidance({ role: 'executor', goalId: 'goal' }))
    for (const command of ['goal plan active --goal ID', 'goal plan revise', 'goal plan assignment', 'goal delegate', 'goal collect', 'goal plan review'])
      expect(manager).toContain(command)
    expect(manager).toContain('Read the saved claim or assignment in `goal plan`')
    expect(manager).toContain('using the same `intent.planNodeId` and the recorded executor')
    expect(manager).toContain('same node and thread for rework')
    expect(manager).toContain('exact delivery hash')
    expect(executor).toContain('goal plan active')
    expect(executor).toContain('Wait for the original dispatch')
    expect(executor).toContain('For local or remote delegations, read the original message with `message read --message-id SOURCE`')
    expect(executor).toContain('Use the verified `envelope.application.data`')
    expect(executor).toContain('use its `ticketLink`')
    expect(executor).toContain('An independent reviewer decides the verdict')
    expect(executor).toContain('Report each criterion as met, gap or unknown with evidence')
    expect(executor).toContain('submission.transport.state: outbox')
  })

  it('leaf help owns the precise derivation, mutation and review reconciliation arguments', () => {
    expect(agentMuxCommandHelp('goal.plan')).toContain('Without a valid planState, node states are unknown to this reader')
    expect(agentMuxCommandHelp('goal.plan')).toContain('{delegationOperationId, reported}')
    expect(agentMuxCommandHelp('goal.plan.revise')).toContain('expectedRevision')
    expect(agentMuxCommandHelp('goal.plan.assignment')).toContain('expectedRevision')
    const claim = agentMuxCommandHelp('goal.plan.claim')
    expect(claim).toContain('--operation-id')
    expect(claim).toContain('use the goalId, nodeId and claimToken returned by goal plan active')
    expect(prose(goalRoleGuidance({ role: 'executor', goalId: 'goal' }))).toContain('goal plan claim --goal')
    const review = agentMuxCommandHelp('goal.plan.review')
    expect(review).toContain('cannot review its own work')
    expect(review).toContain('When the original report has a delivery hash, supply it verbatim.')
    expect(review).toContain('match the saved review operationId, nodeId and delegationOperationId')
    expect(agentMuxCommandHelp('goal.report')).toContain('sourceMessageId')
  })

  it('discovers an explicit planning request without treating discussion or confirmation as plan authority', () => {
    const skill = prose(agentMuxModuleSkill('goal')!)
    expect(skill).toContain('goal discuss --goal ID --mode plan --operation-id OP')
    expect(skill).toContain('Planning can use a real unconfirmed proposal')
    expect(skill).toContain('A delivered request or textual breakdown does not prove a plan was saved')
    const help = agentMuxCommandHelp('goal.discuss')!
    for (const fact of ['open|grill|grounding|plan', '--operation-id', 'A receipt is not a saved plan', 'route=supervisor', 'Busy input retains preparation', 'never starts work']) expect(help, fact).toContain(fact)
  })
})
