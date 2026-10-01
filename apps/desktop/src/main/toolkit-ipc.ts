import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, assertToolkitResultTarget, parseToolkitRequest, parseToolkitResult, parseToolkitSnapshot, type ToolkitRequest, type ToolkitResult, type AgentMuxToolkitPort } from '@agentmux/core/control'
import { TOOLKIT_CHANGED_CHANNEL, TOOLKIT_ENDED_CHANNEL } from '../shared/contracts.js'

export function registerToolkitIpc(port: AgentMuxToolkitPort,
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void): () => void {
  const consumers = new Map<string, () => void>()
  const validId = (id: unknown): string => {
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\0\r\n]/u.test(id)) throw new AgentMuxError('Toolkit consumer identity is invalid.', 'INVALID_CONTROL_REQUEST')
    return id
  }
  const execute = async (raw: unknown): Promise<ToolkitResult> => {
    const request = parseToolkitRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), ...(raw as object) })
    const result = await port.execute(request, new AbortController().signal)
    if (result.operation !== request.operation) throw new AgentMuxError('Toolkit IPC operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
    const { operation: _, ...payload } = result
    const parsed = parseToolkitResult(request.operation, payload)
    assertToolkitResultTarget(request, parsed)
    return parsed
  }
  handle('toolkit:list', () => execute({ operation: 'toolkit.list' }))
  for (const operation of ['get', 'script'] as const) handle('toolkit:' + operation, (_event, toolId: unknown) => execute({ operation: 'toolkit.' + operation, toolId }))
  handle('toolkit:run', (_event, toolId: unknown, input: unknown) => execute({ operation: 'toolkit.run', toolId, ...(input === undefined ? {} : { input }) }))
  handle('toolkit:action', (_event, toolId: unknown, actionId: unknown, input: unknown) => execute({ operation: 'toolkit.action', toolId, actionId, input }))
  handle('toolkit:stop', (_event, toolId: unknown, executionId: unknown) => execute({ operation: 'toolkit.stop', toolId, ...(executionId === undefined ? {} : { executionId }) }))
  handle('toolkit:add', (_event, toolId: unknown, value: unknown) => execute({ operation: 'toolkit.add', toolId, value }))
  handle('toolkit:update', (_event, toolId: unknown, changes: unknown, expected: unknown) => execute({ operation: 'toolkit.update', toolId, changes, ...(expected === undefined ? {} : { expected }) }))
  handle('toolkit:remove', (_event, toolId: unknown, expected: unknown) => execute({ operation: 'toolkit.remove', toolId, ...(expected === undefined ? {} : { expected }) }))
  handle('toolkit:observe', async (event, rawToolId: unknown, rawId: unknown) => {
    const request = parseToolkitRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'toolkit.watch', toolId: rawToolId }) as Extract<ToolkitRequest, { operation: 'toolkit.get' | 'toolkit.script' | 'toolkit.watch' }>
    const id = validId(rawId), sender = event.sender, key = sender.id + ':' + id
    if (consumers.has(key)) throw new AgentMuxError('Toolkit consumer identity is already active.', 'INVALID_CONTROL_REQUEST')
    const controller = new AbortController()
    let closed = false, subscription: { dispose(): void } | undefined
    const close = () => {
      if (closed) return
      closed = true; controller.abort(); subscription?.dispose(); consumers.delete(key)
      sender.off('destroyed', close); sender.off('render-process-gone', close); sender.off('did-start-navigation', navigation)
    }
    const navigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) close() }
    consumers.set(key, close)
    sender.once('destroyed', close); sender.once('render-process-gone', close); sender.on('did-start-navigation', navigation)
    if (sender.isDestroyed()) close()
    try {
      const value = await port.subscribe(request.toolId, snapshot => {
        try {
          const parsed = parseToolkitSnapshot(snapshot)
          if (parsed.toolId !== request.toolId) throw new AgentMuxError('Toolkit snapshot belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
          if (!closed && !sender.isDestroyed()) sender.send(TOOLKIT_CHANGED_CHANNEL, { id, snapshot: parsed })
        } catch (error) {
          try {
            if (!closed && !sender.isDestroyed()) sender.send(TOOLKIT_ENDED_CHANNEL, { id, reason: String(error instanceof Error ? error.message : error) })
          } finally { close() }
        }
      }, error => {
        try {
          if (!closed && !sender.isDestroyed()) sender.send(TOOLKIT_ENDED_CHANNEL, { id, reason: error?.message ?? 'owner-ended' })
        } finally { close() }
      }, controller.signal)
      if (closed || controller.signal.aborted) value.dispose()
      else subscription = value
      return { id }
    } catch (error) { close(); throw error }
  })
  handle('toolkit:release', (event, rawId: unknown) => consumers.get(event.sender.id + ':' + validId(rawId))?.())
  return () => { for (const close of [...consumers.values()]) close() }
}
