import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerToolkitIpc } from '../src/main/toolkit-ipc'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics'

function fixture(toolId = 'performance') {
  const handlers = new Map<string, (...args: any[]) => any>(), snapshot = toolId === 'performance' ? deepMetricsSnapshot() : {
    schema: 'agentmux.toolkit.v1', kind: 'script', toolId,
    definition: { id: toolId, revision: 'display-source', name: 'Display', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: process.cwd(),
      script: 'ordinary()', args: [], display: { script: 'display()', args: [] } },
    state: 'idle', reason: null, admission: null, latestConfirmed: null, sequence: 0, consumerCount: 0 }
  const subscribe = vi.fn(async () => ({ dispose: vi.fn() })), execute = vi.fn(async (request: any) => ({ operation: request.operation, snapshot }))
  const close = registerToolkitIpc({ execute, subscribe }, (channel, handler) => handlers.set(channel, handler))
  const sender = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false, send: vi.fn() })
  return { handlers, subscribe, execute, close, event: { sender }, snapshot }
}
it.each([undefined, { evaluateOnDisplay: true }, { evaluateOnDisplay: false }])('the production IPC reader preserves display options %j in the public subscription', async options => {
  const f = fixture()
  try {
    await f.handlers.get('toolkit:observe')!(f.event, 'performance', 'reader', options)
    expect(f.subscribe).toHaveBeenCalledOnce()
    expect((f.subscribe.mock.calls[0] as unknown[])[4]).toEqual(options)
  } finally { f.close() }
})
it.each([null, [], { evaluateOnDisplay: 'yes' }, { evaluateOnDisplay: true, input: {} }])('rejects invalid IPC display options %j before opening a reader', async options => {
  const f = fixture()
  try {
    await expect(f.handlers.get('toolkit:observe')!(f.event, 'performance', 'reader', options)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(f.subscribe).not.toHaveBeenCalled()
  } finally { f.close() }
})
it('the production IPC evaluate bridge preserves its original captured request input', async () => {
  const f = fixture('display-tool'), input = { invocationId: 'original-display', expectedRevision: 'original-source', expectedLatestExecutionId: 'original-display-result' }
  try {
    const value = await f.handlers.get('toolkit:evaluate')!(f.event, 'display-tool', input)
    expect(value).toEqual({ operation: 'toolkit.evaluate', snapshot: f.snapshot })
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'toolkit.evaluate', toolId: 'display-tool', input }), expect.any(AbortSignal))
  } finally { f.close() }
})
it('the production IPC leaves omitted display input with its original execution owner', async () => {
  const f = fixture('display-tool')
  try {
    await f.handlers.get('toolkit:evaluate')!(f.event, 'display-tool')
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ operation: 'toolkit.evaluate', toolId: 'display-tool' })
    expect(f.execute.mock.calls[0]![0]).not.toHaveProperty('input')
  } finally { f.close() }
})
