import { AgentMuxError } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseSpaceCloseParams, parseSpaceCloseReceipt, spaceCloseDecisions, spaceCloseDigest,
  type SpaceCloseMethod, type SpaceCloseParams, type SpaceCloseResults, type SpaceCloseReceipt } from '@agentmux/core/space-close'

/** Browser demonstration transport only. No Main journal, Native ACK or durable claim. */
export function createPreviewWorkbenchClose() {
  const records = new Map<string, SpaceCloseReceipt>()
  return { async call<M extends SpaceCloseMethod>(method: M, value: SpaceCloseParams[M]): Promise<SpaceCloseResults[M]> {
    const input = parseSpaceCloseParams(method, value)
    if (method === 'space.close.ls') throw new AgentMuxError('Durable close discovery requires the original Desktop Main owner. Preview records live only in this page.', 'CONTROL_UNAVAILABLE')
    const { useAppStore } = await import('../store')
    const request = input as SpaceCloseParams['space.close.prepare'], id = request.operationId
    let record = records.get(id)
    if (method === 'space.close.prepare') {
      if (record && spaceCloseDigest(record.request) !== spaceCloseDigest(request)) throw new AgentMuxError('The preview operation already belongs to another exact plan.', 'WORKBENCH_CLOSE_CONFLICT')
      if (!record) {
        const reply = await useAppStore.getState().executeWorkbenchClose({ operation: 'workbench.close.capture', requestId: mintObjectId(), input: request })
        if (reply.operation !== 'workbench.close.capture') throw new Error('The original preview planner did not return a close projection.')
        const plan = { authority: { ownerId: 'browser-preview', endpoint: 'browser-preview', documentGeneration: 'ephemeral-page' }, target: request.target,
          keepAgentSessions: request.keepAgentSessions, projection: reply.projection, children: reply.projection.resources.map(r => ({ key: r.key, operationId: mintObjectId(), terminal: null,
            issue: r.kind === 'session' && r.control.kind === 'terminal' ? 'native-unconfirmed' as const : null })) }
        const at = Date.now()
        record = parseSpaceCloseReceipt({ operationId: id, request, plan, planDigest: spaceCloseDigest(plan), preparedBy: { kind: 'user', id: 'browser-preview' }, approvedBy: null, decisions: [], phase: 'prepared', outcome: 'prepared',
          resources: plan.children.map(c => ({ key: c.key, operationId: c.operationId, outcome: 'pending', receipt: null })),
          clientProjection: { applied: false, removedRegions: [], retainedRegions: plan.projection.surfaces.map(s => s.owner.regionId), save: null }, spatialContribution: { save: null },
          preparedAt: at, updatedAt: at, diskDurability: 'unconfirmed', issue: 'Browser preview has no original Main journal or Native lifecycle owner. This page cannot confirm durable closing.' })
        records.set(id, record)
      }
    } else if (method === 'space.close.apply') {
      const apply = input as SpaceCloseParams['space.close.apply']
      if (!record || record.planDigest !== apply.expectedPlanDigest || spaceCloseDigest(apply.decisions.map(spaceCloseDigest).sort()) !== spaceCloseDigest(spaceCloseDecisions(record.plan).map(spaceCloseDigest).sort())) throw new AgentMuxError('Keep the original preview plan and exact decisions.', 'WORKBENCH_CLOSE_CONFLICT')
      if (record.phase === 'prepared') {
        record.approvedBy = { kind: 'user', id: 'browser-preview' }; record.decisions = apply.decisions; record.phase = 'applying'; record.outcome = 'unknown'
        record.resources = record.resources.map(r => ({ ...r, outcome: 'unknown', issue: 'Preview does not stop a Run or close a native Browser.' }))
        try {
          await useAppStore.getState().executeWorkbenchClose({ operation: 'workbench.close.reserve', requestId: mintObjectId(), record })
          const reply = await useAppStore.getState().executeWorkbenchClose({ operation: 'workbench.close.commit', requestId: mintObjectId(), record })
          if (reply.operation !== 'workbench.close.commit') throw new Error('The original preview projection result is unavailable.')
          record.clientProjection = reply.result.clientProjection; record.spatialContribution = reply.result.spatialContribution
          record.outcome = record.clientProjection.retainedRegions.length ? 'partial' : 'unknown'
        } finally {
          record.phase = 'settled'; record.updatedAt = Date.now()
          await useAppStore.getState().executeWorkbenchClose({ operation: 'workbench.close.release', requestId: mintObjectId(), record })
        }
      }
    }
    return { operation: record ? structuredClone(record) : null } as SpaceCloseResults[M]
  } }
}
