import { isSensitiveImageText, AgentMuxError, parseNativeDesktopParams, parseNativeDesktopResult, NATIVE_DESKTOP_WRITES,
  type AgentMuxRpcNativeDesktopOwner, type AgentMuxRpcCallContext, type NativeDesktopMethod,
  type NativeDesktopParamsMap, type NativeDesktopPayloadMap, type NativeDesktopReply, type NativeDesktopJson } from '@agentmux/core'
import { NativeRequestError, type NativeDesktop, type NativeMethod, type JsonObject } from '@agentmux/native-desktop'

type NativePort = Pick<NativeDesktop, 'request' | 'inspectOperation'>
/** Region selection is a Desktop surface over native frozen frames, not a native picker. */
type SelectionPort = { captureSelection(): Promise<NativeDesktopPayloadMap['native.capture']> }
function actor(context?: AgentMuxRpcCallContext): string {
  if (context?.caller) return `agent:${context.caller.agentSessionId}`
  if (context?.principal && ['user', 'device'].includes(context.principal.kind)) return `${context.principal.kind}:${context.principal.id}`
  throw new AgentMuxError('Native desktop requires its transport-authenticated actor.', 'CONTROL_PERMISSION_DENIED')
}
function nativeTarget(target: { pid: number; processStartedAt: number; windowId?: number }): JsonObject {
  return { app: `pid:${target.pid}`, processStartedAt: target.processStartedAt,
    ...(target.windowId === undefined ? {} : { windowId: target.windowId }) }
}

/** Host adapter only: all OS state and operation results stay at the shared native owner. */
export function createNativeDesktopPublicOwner(native: NativePort, host: { hostId: string }, selection: SelectionPort): AgentMuxRpcNativeDesktopOwner {
  // These are receipt access bindings, not another operation/result store.
  const receiptActors = new Map<string, { actor: string; instanceId: string }>()
  // Selection receipts: the surface answers them, so the native owner never saw these operation IDs.
  const selections = new Map<string, { actor: string; instanceId: string; state: 'pending' | 'completed' }>()
  return {
    async call<M extends NativeDesktopMethod>(method: M, value: NativeDesktopParamsMap[M], context?: AgentMuxRpcCallContext): Promise<NativeDesktopReply> {
      const input = parseNativeDesktopParams<NativeDesktopMethod>(method, value)
      const actorId = actor(context)
      if (input.hostId !== host.hostId) throw new AgentMuxError('This native owner belongs to another exact Host.', 'NATIVE_HOST_MISMATCH')
      context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
      if (method === 'native.operation.inspect') {
        const p = input as NativeDesktopParamsMap['native.operation.inspect']
        const binding = receiptActors.get(p.operationId) ?? selections.get(p.operationId)
        if (binding && (binding.actor !== actorId || binding.instanceId !== p.instanceId)) throw new AgentMuxError('The original native operation belongs to another actor or instance.', 'CONTROL_PERMISSION_DENIED')
        const chosen = selections.get(p.operationId)
        const operation = chosen ? { operationId: p.operationId, instanceId: p.instanceId, method: 'captureScreenshot', state: chosen.state }
          : binding ? native.inspectOperation(p.operationId, p.instanceId) : {
          operationId: p.operationId, instanceId: p.instanceId, state: 'unknown', reason: 'original_receipt_unavailable'
        }
        return parseNativeDesktopResult(method, { hostId: host.hostId, instanceId: p.instanceId, state: 'responded', result: operation }, value)
      }
      let nativeMethod: NativeMethod
      let params: JsonObject = {}
      const clientScope = actorId
      if (method === 'native.capabilities') nativeMethod = 'handshake'
      else if (method === 'native.text.recognize') { nativeMethod = 'recognizeText'; params = { data: (input as NativeDesktopParamsMap['native.text.recognize']).data } }
      else if (method === 'native.apps.list') nativeMethod = 'listApps'
      else if (method === 'native.displays.list') nativeMethod = 'listDisplays'
      else if (method === 'native.permissions.inspect') nativeMethod = 'permissionStatus'
      else if (method === 'native.windows.list') {
        nativeMethod = 'listWindows'; params = nativeTarget((input as NativeDesktopParamsMap['native.windows.list']).target)
      } else if (method === 'native.snapshot') {
        const p = input as NativeDesktopParamsMap['native.snapshot']
        nativeMethod = 'getAppState'; params = { ...nativeTarget(p.target), clientScope, noScreenshot: true }
      } else if (method === 'native.capture' && (input as NativeDesktopParamsMap['native.capture']).capture.mode === 'selection') {
        const p = input as NativeDesktopParamsMap['native.capture']
        // A repeated operation is refused in the same shape as a native write; it never opens a second surface.
        if (receiptActors.has(p.operationId) || selections.has(p.operationId)) return parseNativeDesktopResult(method, { hostId: host.hostId, instanceId: p.instanceId, state: 'responded',
          operationId: p.operationId, error: { code: 'duplicate_operation', message: 'Inspect the original operation; it will not be executed again' } }, value)
        const receipt = { actor: actorId, instanceId: p.instanceId, state: 'pending' as 'pending' | 'completed' }
        selections.set(p.operationId, receipt)
        const result = await selection.captureSelection().finally(() => { receipt.state = 'completed' })
        return parseNativeDesktopResult(method, { hostId: host.hostId, instanceId: p.instanceId, state: 'responded', operationId: p.operationId, result: result as unknown as NativeDesktopJson }, value)
      } else if (method === 'native.capture') {
        const p = input as NativeDesktopParamsMap['native.capture']
        nativeMethod = 'captureScreenshot'
        params = p.capture.mode === 'window' ? { mode: 'window', ...nativeTarget(p.capture.target) } : p.capture
      } else if (method === 'native.clipboard.read') {
        nativeMethod = 'clipboardRead'; params = { format: (input as NativeDesktopParamsMap['native.clipboard.read']).format }
      } else if (method === 'native.clipboard.write') {
        const p = input as NativeDesktopParamsMap['native.clipboard.write']
        nativeMethod = 'clipboardWrite'; params = { format: p.format, data: p.data }
      } else {
        const p = input as NativeDesktopParamsMap['native.action']
        const { kind, ...args } = p.action
        nativeMethod = kind
        params = { ...nativeTarget(p.target), snapshotId: p.snapshotId, clientScope, noScreenshot: true, ...args }
      }
      const operationId = NATIVE_DESKTOP_WRITES.has(method) ? (input as { operationId: string }).operationId : undefined
      const instanceId = 'instanceId' in input ? input.instanceId : undefined
      if (operationId && instanceId) {
        const old = receiptActors.get(operationId)
        if (old && (old.actor !== actorId || old.instanceId !== instanceId)) throw new AgentMuxError('The original operation cannot be reassigned to another actor or native instance.', 'CONTROL_PERMISSION_DENIED')
      }
      try {
        const result = await native.request(nativeMethod, params, {
          beforeSubmit: async () => { context?.signal?.throwIfAborted(); await context?.assertCurrent?.(); context?.signal?.throwIfAborted() },
          ...(operationId ? { operationId } : {}), ...(instanceId ? { expectedInstanceId: instanceId } : {}),
          ...(method === 'native.capture' ? { timeoutMs: 120_000 } : {})
        })
        if (operationId && instanceId) receiptActors.set(operationId, { actor: actorId, instanceId })
        const responseInstance = instanceId ?? (result && typeof result === 'object' && !Array.isArray(result) && typeof result.instanceId === 'string' ? result.instanceId : '')
        const reply = parseNativeDesktopResult(method, { hostId: host.hostId, instanceId: responseInstance, state: 'responded',
          ...(operationId ? { operationId } : {}), result }, value)
        if (method === 'native.text.recognize' && (input as NativeDesktopParamsMap['native.text.recognize']).sensitiveOnly) {
          const recognized = reply.result as unknown as NativeDesktopPayloadMap['native.text.recognize']
          recognized.lines = recognized.lines.filter(line => isSensitiveImageText(line.text))
        }
        return reply
      } catch (error) {
        if (!(error instanceof NativeRequestError) || !instanceId) throw error
        if (operationId && error.operation?.operationId === operationId && error.operation.instanceId === instanceId &&
            error.code !== 'duplicate_operation' && error.code !== 'operation_conflict') receiptActors.set(operationId, { actor: actorId, instanceId })
        const binding = operationId ? receiptActors.get(operationId) : undefined
        const ownsReceipt = binding?.actor === actorId && binding.instanceId === instanceId
        const unknown = ownsReceipt && error.operation?.state === 'unknown' && error.code !== 'duplicate_operation' && error.code !== 'operation_conflict'
        return parseNativeDesktopResult(method, { hostId: host.hostId, instanceId, state: unknown ? 'unknown' : 'responded',
          ...(operationId ? { operationId } : {}), error: { code: error.code, message: error.message },
          ...(ownsReceipt && error.operation ? { operation: error.operation as unknown as NativeDesktopJson } : {}) }, value)
      }
    }
  }
}
