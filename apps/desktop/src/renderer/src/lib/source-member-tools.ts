import type { SpaceMountPort, SpaceMountSessionTarget, SpaceMountMemberTarget, SpaceMountMemberSurface } from '../../../shared/space-mount'
import type { OriginalContinuousProgressControl } from '../../../shared/continuous-progress'
import type { ComposerImageRetention } from './use-composer-attachments'

/** Original tool calls reuse the existing fixed member surface. A durable Session
 * purpose is explicit and does not borrow its conversation reader's grant. */
export function sourceMemberProgress(port: Pick<SpaceMountPort, 'member' | 'reading'>, member: SpaceMountSessionTarget,
  metadata: { providerId: string; workspacePath: string }): OriginalContinuousProgressControl {
  const target = { hostId: 'local', agentSessionId: member.target.agentSessionId, ...metadata }
  const original = (value: typeof target) => {
    if (['hostId', 'agentSessionId', 'providerId', 'workspacePath'].some(key => value[key as keyof typeof target] !== target[key as keyof typeof target]))
      throw new Error('This arrangement belongs to another original Session or workspace. Its original request is kept.')
  }
  const call = async <M extends import('@agentmux/core').AgentProgressMethod>(method: M, input: import('@agentmux/core').AgentProgressParams[M]) => {
    original(input.target)
    const surface = await port.member(member, () => {})
    try { return await surface.call(method, input) }
    finally { await surface.dispose() }
  }
  return { identity: JSON.stringify([member, metadata.providerId, metadata.workspacePath]), target, executionState: 'unknown',
    port: {
      list: async (target, operationId) => (await call('agent.progress.list', { target, ...(operationId === undefined ? {} : { operationId }) })).loops,
      create: async input => (await call('agent.progress.create', input)).loop,
      update: async input => (await call('agent.progress.update', input)).loop,
      action: async (target, loopId, action, expectedLoop, operationId) => (await call('agent.progress.action', { target, loopId, action, expectedLoop, operationId })).loop
    },
    readInputEpoch: async () => {
      const surface = await port.reading({ ...member, target: { ...member.target, kind: 'conversation' } }, () => {})
      try { return await surface.call('inputEpoch', {}) }
      finally { await surface.dispose() }
    }
  }
}

/** The original Core checks this explicit Run at upload; no observer path is sent. */
export function sourceMemberImageRetention(port: Pick<SpaceMountPort, 'member'>, target: SpaceMountMemberTarget,
  existing?: SpaceMountMemberSurface): ComposerImageRetention {
  return async (bytes, mimeType) => {
    const surface = existing ?? await port.member(target, () => {})
    try { return await surface.call('retainImage', { bytes, mimeType }) }
    finally { if (!existing) await surface.dispose() }
  }
}
