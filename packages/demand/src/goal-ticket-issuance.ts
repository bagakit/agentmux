import { goalTicketTask, type GoalPlan, type GoalPlanNodeInput, type GoalPlanProposalReceipt } from './goal-plan.js'
import type { DemandCriterion } from './goals.js'
import type { GoalPlanPredecessor } from './delegations.js'
import type { GoalTicketActor, GoalTicketProof, GoalTicketSigner } from './goal-ticket-proof.js'

/** Incoming IDs of new nodes serve as local names within this one revision. */
export function issueGoalTickets(issuer: GoalTicketSigner, goalId: string, operationId: string, actor: GoalTicketActor,
  nodes: readonly GoalPlanNodeInput[], previous: GoalPlan | undefined, criteria: readonly DemandCriterion[], proposals: readonly GoalPlanProposalReceipt[]) {
  const originalIds = new Set(previous?.nodes.map(node => node.id))
  const ids = new Map(Array.from(originalIds, id => [id, id]))
  const input = new Map(nodes.map(node => [node.id, node]))
  const proposalByNode = new Map(proposals.map(proposal => [proposal.nodeId, proposal]))
  const createdTickets: GoalTicketProof[] = [], verified = new Set<string>()
  const resolve = (id: string): string => {
    const known = ids.get(id)
    if (known) return known
    const node = input.get(id)!
    const predecessors = node.dependsOn.map(dependency => {
      if (previous && originalIds.has(dependency) && !verified.has(dependency)) {
        assertIssuedGoalTicket(issuer, goalId, previous, dependency)
        verified.add(dependency)
      }
      return resolve(dependency)
    }).sort()
    const proposal = proposalByNode.get(id)
    const proof = issuer.issue({ kind: 'issued', scope: { ...issuer.owner, goalId }, operationId, actor, draftId: id,
      task: goalTicketTask(node, criteria), predecessors, ...(proposal ? { proposal: {
        attemptId: proposal.delegationOperationId, replyId: proposal.replyMessageId,
        author: { kind: 'agent', id: proposal.author.agentSessionId, runtimeId: proposal.author.runtimeId },
      } } : {}) })
    ids.set(id, proof.hash)
    createdTickets.push(proof)
    return proof.hash
  }
  return {
    nodes: nodes.map(node => ({ ...node, id: resolve(node.id), dependsOn: node.dependsOn.map(resolve) })),
    proposals: proposals.map(proposal => ({ ...proposal, nodeId: resolve(proposal.nodeId) })),
    createdTickets,
  }
}

export function assertIssuedGoalTicket(issuer: GoalTicketSigner, goalId: string, plan: GoalPlan, nodeId: string): void {
  const proof = plan.history.find(entry => entry.createdTickets?.some(proof => proof.hash === nodeId))?.createdTickets?.find(proof => proof.hash === nodeId)
  if (!proof || proof.record.kind !== 'issued' || proof.record.scope.goalId !== goalId) throw new Error('The original Ticket issuance is unavailable')
  issuer.verify(proof)
}

export function freezeGoalTicketDependencies(issuer: GoalTicketSigner, goalId: string, plan: GoalPlan, predecessors: readonly GoalPlanPredecessor[]) {
  if (predecessors.length === 0) return []
  const byReview = new Map(plan.reviews.map(review => [review.operationId, review]))
  return predecessors.map(ref => {
    const proof = byReview.get(ref.reviewOperationId)?.completion
    if (!proof || proof.hash !== ref.completionHash || proof.record.kind !== 'completed' || proof.record.scope.goalId !== goalId ||
        proof.record.ticketId !== ref.nodeId || proof.record.attemptId !== ref.delegationOperationId || proof.record.deliveryHash !== ref.deliveryHash)
      throw new Error('The direct predecessor lacks its original signed completion')
    issuer.verify(proof)
    return { ticketId: ref.nodeId, completionHash: proof.hash }
  })
}
