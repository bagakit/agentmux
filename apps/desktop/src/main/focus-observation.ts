import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError } from '@agentmux/core'
import { parseFocusResult, type AgentMuxFocusSource } from '@agentmux/core/focus-control'
import type { AgentMuxControlFocusReadRequest, AgentMuxControlResult } from '@agentmux/core/control'
import type { DesktopLoadedRenderer } from '../shared/client-observation.js'

/** One original client observation owner, with no member or Session state of its own. */
export function createFocusObservation(owner: {
  renderer(): DesktopLoadedRenderer | null
  generation(): number | null
  execute(request: AgentMuxControlFocusReadRequest, signal?: AbortSignal): Promise<AgentMuxControlResult>
}) {
  const clientId = mintObjectId()
  return async (request: AgentMuxControlFocusReadRequest, signal?: AbortSignal): Promise<AgentMuxControlResult> => {
    const renderer = owner.renderer(), generation = owner.generation()
    if (!renderer || generation === null) throw new AgentMuxError(
      'The original loaded Focus reader is unavailable. Keep its exact group reference; Agent discovery and existing work remain available.', 'CONTROL_UNAVAILABLE')
    const source: AgentMuxFocusSource = { clientId, rendererId: renderer.id, documentGeneration: generation }
    signal?.throwIfAborted()
    const result = await owner.execute({ ...request, source }, signal)
    if (owner.renderer() !== renderer || owner.generation() !== generation) throw new AgentMuxError(
      'The original Desktop document changed during this Focus read. Keep the scope and read it again; no workface was changed.', 'CONTROL_UNAVAILABLE')
    if (result.operation !== request.operation || !('page' in result)) throw new AgentMuxError('Focus returned another original operation.', 'CONTROL_PROTOCOL_ERROR')
    const page = parseFocusResult(request.operation, result.page, request.input)
    if (JSON.stringify(page.source) !== JSON.stringify(source)) throw new AgentMuxError('Focus returned another original client document.', 'CONTROL_PROTOCOL_ERROR')
    return request.operation === 'focus.ls'
      ? { operation: request.operation, page: parseFocusResult('focus.ls', page, request.input) }
      : { operation: request.operation, page: parseFocusResult('focus.read', page, request.input) }
  }
}
