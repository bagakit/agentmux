import { describe, expect, it } from 'vitest'
import { buildClaudeNativeExecutorLaunchSpec, CLAUDE_EXECUTION_TOOL_NAMES, parseClaudeExecutionMessage,
  parseClaudeExecutionServerMessage, projectClaudeExecutionResponse } from '../src/providers/claude-execution-protocol.js'

const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }
function request(method: string, params: Record<string, unknown>, id: number | string = 1) {
  const result = parseClaudeExecutionMessage({ jsonrpc: '2.0', id, method, params })
  expect(result.kind).toBe('request')
  if (result.kind !== 'request') throw new Error('Expected a qualified request')
  return result
}
const call = (name: string, args: Record<string, unknown>) => request('tools/call', { name, arguments: args })

describe('Claude native MCP execution interpretation', () => {
  it('retains exact initialization and notification envelopes without a second MCP handshake', () => {
    expect(parseClaudeExecutionMessage(initialize)).toMatchObject({ kind: 'request', requestId: 0, intent: { initialize: true } })
    for (const payload of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '1', reason: 'User cancelled' } }]) {
      expect(parseClaudeExecutionMessage(payload)).toEqual({ kind: 'notification', method: payload.method, payload })
    }
    for (const id of [0, '0']) {
      const payload = { jsonrpc: '2.0', id, result: { capabilities: { tools: {} } } }
      expect(parseClaudeExecutionServerMessage(payload)).toEqual({ kind: 'response', requestId: id, payload })
    }
  })

  it.each(['Read', 'Write', 'Edit', 'NotebookEdit'])('keeps exact resource paths and effect intent for %s', tool => {
    const path = '/resource/a b/../original'
    const args = tool === 'NotebookEdit' ? { notebook_path: path, new_source: 'cell' } : { file_path: path, content: 'authored', old_string: 'old', new_string: 'new' }
    const message = call(tool, args)
    expect(message.intent).toEqual({ kind: tool === 'Read' ? 'read' : 'write', paths: [{ path, access: tool === 'Read' ? 'read' : 'write' }] })
    expect((message.payload.params as Record<string, unknown>).arguments).toBe(args)
    expect(call(tool, { ...args, [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: 'C:\\resource\\original' }).kind).toBe('request')
  })

  it('preserves shell bytes and native task identity without inferring a filesystem sandbox', () => {
    const args = { command: 'cd "$ROOT" && cat input; printf x >> "$OUT"', run_in_background: true, dangerouslyDisableSandbox: false }
    expect(call('Bash', args)).toMatchObject({ intent: { kind: 'process', paths: [] } })
    expect((call('Bash', args).payload.params as Record<string, unknown>).arguments).toBe(args)
    expect(call('TaskStop', { task_id: 'native-original-task' }).intent).toEqual({ kind: 'process', paths: [], processId: 'native-original-task' })
  })

  it('projects only the native tool catalog and independently refuses excluded tools', () => {
    const all = [...CLAUDE_EXECUTION_TOOL_NAMES.map(name => ({ name, inputSchema: { type: 'object' } })), ...['Agent', 'Skill', 'EnterWorktree', 'Workflow'].map(name => ({ name }))]
    const response = { jsonrpc: '2.0', id: 'catalog', result: { tools: all, nextCursor: 'native-page' } }
    const projected = projectClaudeExecutionResponse(request('tools/list', {}, 'catalog'), response)
    expect((projected.result as Record<string, unknown>).tools).toEqual(all.slice(0, 6))
    expect((projected.result as Record<string, unknown>).nextCursor).toBe('native-page')
    expect(response.result.tools).toBe(all)
    for (const name of ['Agent', 'Skill', 'EnterWorktree', 'Workflow', 'Glob', 'Grep']) expect(parseClaudeExecutionMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { file_path: '/resource/valid', command: 'touch file' } } })).toMatchObject({ kind: 'rejected', code: -32601 })
    expect(projectClaudeExecutionResponse(call('Read', { file_path: '/original' }), response)).toBe(response)
    const error = { jsonrpc: '2.0', id: 'catalog', error: { code: -32603, message: 'native unavailable' } }
    expect(projectClaudeExecutionResponse(request('tools/list', {}, 'catalog'), error)).toBe(error)
    expect(() => projectClaudeExecutionResponse(request('tools/list', {}), { result: { tools: [null] } })).toThrow()
  })

  it('admits qualified server notifications without accepting server-origin actions', () => {
    for (const method of ['notifications/progress', 'notifications/message', 'notifications/tools/list_changed']) {
      const payload = { jsonrpc: '2.0', method, params: { progress: 1 } }
      expect(parseClaudeExecutionServerMessage(payload)).toEqual({ kind: 'notification', method, payload })
      expect(parseClaudeExecutionMessage(payload).kind).toBe('rejected')
    }
    expect(parseClaudeExecutionServerMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })).toMatchObject({ kind: 'notification' })
    expect(parseClaudeExecutionServerMessage({ jsonrpc: '2.0', id: 1, method: 'roots/list', params: {} }).kind).toBe('rejected')
  })

  it.each([null, [], { ...initialize, id: null }, { ...initialize, id: 1.5 }, { ...initialize, jsonrpc: '1.0' },
    { ...initialize, result: {} }, { ...initialize, params: { protocolVersion: 'x' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: { file_path: 'relative' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Bash', arguments: { command: '' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'TaskStop', arguments: {} } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: null } },
    { jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'conflict' } },
  ])('rejects malformed or unqualified native facts without changing healthy requests', payload => {
    expect(parseClaudeExecutionMessage(payload).kind).toBe('rejected')
    expect(parseClaudeExecutionMessage(initialize).kind).toBe('request')
  })

  it('launches the exact native resource server using argv, with no shell or copied tool implementation', () => {
    expect(buildClaudeNativeExecutorLaunchSpec({ executable: '/opt/claude', cwd: '/resource/a b' })).toEqual({ program: '/opt/claude', args: ['mcp', 'serve'], cwd: '/resource/a b', transport: 'stdio' })
    expect(() => buildClaudeNativeExecutorLaunchSpec({ executable: 'claude', cwd: '/resource' })).toThrow(TypeError)
  })
})
