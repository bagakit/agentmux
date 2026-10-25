import { describe, expect, it } from 'vitest'
import { buildCodexNativeExecutorLaunchSpec, parseCodexExecutionMessage, parseCodexExecutionServerMessage } from '../src/providers/codex-execution-protocol.js'

const sandbox = { permissions: { type: 'disabled' }, cwd: 'file:///workspace', workspaceRoots: ['file:///workspace'], windowsSandboxLevel: 'disabled' }
function request(method: string, params: Record<string, unknown>, id: string | number = 7) {
  const payload = { id, method, params }
  const result = parseCodexExecutionMessage(payload)
  expect(result.kind).toBe('request')
  if (result.kind !== 'request') throw new Error(JSON.stringify(result))
  expect(result.payload).toBe(payload)
  expect(result.params).toBe(params)
  expect(result.requestId).toBe(id)
  return result
}

describe('native execution protocol boundary', () => {
  it.each([
    { method: 'process/output', params: { processId: 'p', seq: 1, stream: 'stdout', chunk: 'b2s=' } },
    { method: 'process/exited', params: { processId: 'p', seq: 2, exitCode: 0, sandboxDenied: false } },
    { method: 'process/closed', params: { processId: 'p', seq: 3 } },
  ])('preserves server-origin native events without accepting client injection', payload => {
    expect(parseCodexExecutionServerMessage(payload)).toEqual({ kind: 'notification', method: payload.method, payload })
    expect(parseCodexExecutionMessage(payload).kind).toBe('rejected')
  })
  it('refuses unsupported and malformed server notifications without inventing completion', () => {
    for (const payload of [{ method: 'process/future', params: { processId: 'p', seq: 1 } }, { method: 'process/output', params: { processId: 'p', seq: -1, stream: 'stdout', chunk: '' } }, { id: 1, method: 'process/closed', params: { processId: 'p', seq: 1 } }]) expect(parseCodexExecutionServerMessage(payload).kind).toBe('rejected')
    expect(parseCodexExecutionServerMessage({ id: 1, result: {} })).toMatchObject({ kind: 'response', requestId: 1 })
  })
  it('passes native initialization envelopes without maintaining a second handshake', () => {
    expect(request('initialize', { clientName: 'codex-environment', resumeSessionId: null }, 1).intent).toEqual({ kind: 'control', paths: [], initialize: true, resumeSessionId: null })
    expect(request('initialize', { clientName: 'codex-environment', resumeSessionId: 'original-native-session' }, 1).intent.resumeSessionId).toBe('original-native-session')
    const initialized = { method: 'initialized', params: {} }
    expect(parseCodexExecutionMessage(initialized)).toEqual({ kind: 'notification', method: 'initialized', payload: initialized })
    for (const payload of [{ id: 1, result: { sessionId: 'original-native-session' } }, { id: '1', error: { code: -32602, message: 'invalid parameters' } }]) {
      expect(parseCodexExecutionMessage(payload)).toEqual({ kind: 'response', requestId: payload.id, payload })
    }
  })

  it('preserves captured startup metadata, walk and environment config requests', () => {
    const path = 'file:///workspace/a%20b/../repo/.git'
    expect(request('fs/getMetadata', { path, sandbox: null }).intent).toEqual({ kind: 'read', paths: [{ path, access: 'read', sandbox: null }], sandbox: null })
    expect(request('fs/walk', { path: 'file:///workspace/.codex/skills', options: { maxDepth: 6, maxDirectories: 2000, maxEntries: 20000, followDirectorySymlinks: true, pruneHiddenDirectories: true }, sandbox: null }).intent.kind).toBe('read')
    const config = request('environmentConfig/read', { cwd: 'file:///workspace', configPaths: [['mcp_servers']], requirementsPaths: [['mcp_servers']] })
    expect(config.intent).toEqual({ kind: 'read', paths: [{ path: 'file:///workspace', access: 'read' }], cwd: 'file:///workspace', environmentConfig: true })
    expect(parseCodexExecutionMessage({ id: 0, method: 'environment/info' })).toMatchObject({ kind: 'request', intent: { kind: 'control' } })
  })

  it.each(['fs/readFile', 'fs/getMetadata', 'fs/canonicalize', 'fs/readDirectory'])('marks %s as a read without normalizing native paths', method => {
    const path = 'file://executor/share/%FF/name'
    expect(request(method, { path, sandbox }).intent.paths).toEqual([{ path, access: 'read', sandbox }])
  })

  it.each([
    ['fs/writeFile', { dataBase64: 'aGVsbG8=' }],
    ['fs/createDirectory', { recursive: true }],
    ['fs/remove', { force: false, recursive: true }],
  ])('marks %s as a write and preserves its sandbox', (method, extra) => {
    const result = request(method, { path: 'file:///workspace/output', sandbox, ...extra })
    expect(result.intent.kind).toBe('write')
    expect(result.intent.sandbox).toBe(sandbox)
    expect(result.intent.paths).toEqual([{ path: 'file:///workspace/output', access: 'write', sandbox }])
  })

  it('requires authorization for both copy endpoints with their distinct access', () => {
    expect(request('fs/copy', { sourcePath: 'file:///source', destinationPath: 'file:///destination', recursive: false, sandbox }).intent.paths).toEqual([
      { path: 'file:///source', access: 'read', sandbox }, { path: 'file:///destination', access: 'write', sandbox },
    ])
    expect(parseCodexExecutionMessage({ id: 1, method: 'fs/copy', params: { sourcePath: 'file:///source', recursive: false } })).toMatchObject({ kind: 'rejected', code: -32602 })
  })

  it('keeps native handles explicit, without claiming handle ownership', () => {
    expect(request('fs/open', { handleId: 'read-1', path: 'file:///workspace/file', sandbox }).intent).toMatchObject({ kind: 'read', handleId: 'read-1', handle: { kind: 'file', id: 'read-1', action: 'create' } })
    expect(request('fs/readBlock', { handleId: 'read-1', offset: 0, len: 65536 }).intent).toEqual({ kind: 'read', paths: [], handleId: 'read-1', handle: { kind: 'file', id: 'read-1', action: 'use' } })
    expect(request('fs/close', { handleId: 'read-1' }).intent).toEqual({ kind: 'control', paths: [], handleId: 'read-1', handle: { kind: 'file', id: 'read-1', action: 'close' } })
    expect(parseCodexExecutionMessage({ id: 9, method: 'fs/readBlock', params: { fileId: 'read-1', offset: 0, len: 1 } })).toMatchObject({ kind: 'rejected', code: -32602 })
  })

  it('keeps process argv, cwd and sandbox exact rather than inferring effects from command text', () => {
    const argv = ['/bin/sh', '-c', 'cat "$TARGET"; rm -f "$OTHER"']
    const params = { processId: 'command-3', argv, cwd: 'file:///workspace/a%20b', env: { TARGET: 'input', OTHER: 'output' }, tty: false, pipeStdin: true, arg0: null, sandbox, enforceManagedNetwork: true, managedNetwork: { allowedHosts: [] } }
    const result = request('process/start', params)
    expect(result.intent).toEqual({ kind: 'process', paths: [], argv, cwd: params.cwd, processId: 'command-3', sandbox, handle: { kind: 'process', id: 'command-3', action: 'create' } })
    expect(result.intent.argv).toBe(argv)
    expect(result.intent.sandbox).toBe(sandbox)
    expect(result.payload.params).toBe(params)
  })

  it.each([
    ['process/read', { afterSeq: 5, maxBytes: 1024, waitMs: 0 }, 'read'],
    ['process/write', { chunk: 'Cg==', writeId: 'stdin-4' }, 'process'],
    ['process/signal', { signal: 'interrupt' }, 'process'],
    ['process/terminate', {}, 'process'],
  ])('retains native process identity for %s', (method, extra, kind) => {
    expect(request(method, { processId: 'original-process', ...extra }, 'req-1').intent).toEqual({ kind, paths: [], processId: 'original-process', handle: { kind: 'process', id: 'original-process', action: 'use' } })
  })

  it('preserves each discovery root and its own sandbox', () => {
    expect(request('capabilityRoots/discoverV1', { roots: [{ id: 'a', path: 'file:///skills', sandbox }, { id: 'b', path: 'file:///plugins', sandbox: null }] }).intent.paths).toEqual([
      { path: 'file:///skills', access: 'read', sandbox }, { path: 'file:///plugins', access: 'read', sandbox: null },
    ])
  })

  it.each([
    { id: 1, method: 'fs/futureWrite', params: { path: 'file:///workspace' } },
    { id: 1, method: 'http/request', params: { method: 'GET', url: 'https://example.invalid' } },
    { method: 'process/terminate', params: { processId: 'victim' } },
    { method: 'process/output', params: { processId: 'victim' } },
  ])('refuses unsupported client operations without granting read/control access', payload => {
    expect(parseCodexExecutionMessage(payload)).toMatchObject({ kind: 'rejected', code: -32601 })
    expect(request('fs/readFile', { path: 'file:///workspace/healthy', sandbox: null }).intent.kind).toBe('read')
  })

  it.each([
    null, [], { id: null, method: 'initialize' }, { id: 1.5, method: 'initialize' }, { id: Number.MAX_SAFE_INTEGER + 1, method: 'initialize' },
    { id: 1, method: 'fs/readFile', params: { path: '/workspace' } },
    { id: 1, method: 'fs/readFile', params: { path: 'https://example.invalid/file' } },
    { id: 1, method: 'fs/readFile', params: { path: 'file:///workspace', sandbox: true } },
    { id: 1, method: 'process/start', params: { processId: 'p', argv: [], cwd: 'file:///workspace', env: {}, tty: false } },
    { id: 1, method: 'process/signal', params: { processId: 'p', signal: 'kill' } },
    { id: 1, method: 'process/read', params: { processId: 'p', afterSeq: -1 } },
    { id: 1, method: 'fs/writeFile', params: { path: 'file:///workspace', dataBase64: 'not base64' } },
    { id: 1, method: 'fs/readFile', result: {}, params: { path: 'file:///workspace' } },
    { id: 1, result: {}, error: { code: 1, message: 'conflicting envelope' } },
  ])('rejects malformed requests locally', payload => {
    expect(parseCodexExecutionMessage(payload).kind).toBe('rejected')
  })

  it('builds an argv launch spec with explicit concurrency and no shell interpolation', () => {
    expect(buildCodexNativeExecutorLaunchSpec({ executable: '/opt/bin/codex', cwd: '/work tree', concurrentRequests: 32 })).toEqual({ program: '/opt/bin/codex', args: ['exec-server', '--listen', 'stdio://', '--concurrent-requests', '32'], cwd: '/work tree', transport: 'stdio' })
    for (const concurrentRequests of [0, -1, 1.5, Infinity]) expect(() => buildCodexNativeExecutorLaunchSpec({ executable: 'codex', cwd: '/workspace', concurrentRequests })).toThrow(TypeError)
  })
})
