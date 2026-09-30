import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseToolkitResult, parseToolkitSnapshot, type ToolkitRequest, type ToolkitResult, type AgentMuxToolkitPort } from '@agentmux/core/control'
import { TOOLKIT_CHANGED_CHANNEL, TOOLKIT_ENDED_CHANNEL } from '../shared/contracts.js'

export function registerToolkitIpc(port: AgentMuxToolkitPort,
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void): () => void {
  const consumers = new Map<string, () => void>()
  const validId = (id: unknown): string => {
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\0\r\n]/u.test(id)) throw new AgentMuxError('Toolkit consumer identity is invalid.', 'INVALID_CONTROL_REQUEST')
    return id
  }
  const execute = async (operation: ToolkitRequest['operation']): Promise<ToolkitResult> => {
    const result = await port.execute({schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation, toolId: 'performance' }, new AbortController().signal)
    if (result.operation !== operation) throw new AgentMuxError('Toolkit IPC operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
    const {operation:_,...payload}=result
    return parseToolkitResult(operation,payload)
  }
  for (const operation of ['list','get','script','run','stop'] as const) handle('toolkit:' + operation, () => execute('toolkit.' + operation as ToolkitRequest['operation']))
  handle('toolkit:observe', async (event, rawId: unknown) => {
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
      const value = await port.subscribe('performance', snapshot => {
        if (!closed && !sender.isDestroyed()) sender.send(TOOLKIT_CHANGED_CHANNEL, { id, snapshot: parseToolkitSnapshot(snapshot) })
      }, error => {
        if (!closed && !sender.isDestroyed()) sender.send(TOOLKIT_ENDED_CHANNEL, { id, reason: error?.message ?? 'owner-ended' })
        close()
      }, controller.signal)
      if (closed || controller.signal.aborted) value.dispose()
      else subscription = value
      return { id }
    } catch (error) { close(); throw error }
  })
  handle('toolkit:release', (event, rawId: unknown) => consumers.get(event.sender.id + ':' + validId(rawId))?.())
  return () => { for (const close of [...consumers.values()]) close() }
}
