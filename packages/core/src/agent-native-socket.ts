import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { JSONRPCClient, type JSONRPCResponse } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { openNativeProcessImage } from './agent-native-process.js'
import { resolveCoreBinPath } from './runtime-paths.js'
import { runProcess } from './process-runner.js'

export type NativeSocketBinding = Readonly<{
  schema: 1; runPid: number; tuiPid: number; peerPid: number; uid: number
  tuiFd: number; peerFd: number; tuiSocket: string; peerSocket: string
  runBirth: string; tuiBirth: string; peerBirth: string
  device: string; inode: string; endpoint: string
}>
export type NativeSocketChannel = {
  binding: NativeSocketBinding
  sourceId: string
  request(method: string, params: unknown, id?: string, signal?: AbortSignal): Promise<JSONRPCResponse>
  notify(method: string, params?: unknown): void
  assertCurrent(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

/** Representative FD turnover does not create a different original actor. */
export function nativeSocketSourceId(value: NativeSocketBinding): string {
  const { tuiFd: _tuiFd, peerFd: _peerFd, ...actorIdentity } = value
  return createHash('sha256').update(JSON.stringify(actorIdentity)).digest('base64url')
}

function failure(phase: string, reason: string): AgentMuxError {
  return new AgentMuxError('The original native socket is unconfirmed. The Agent and message remain available.',
    'AGENT_NATIVE_INPUT_UNCONFIRMED', JSON.stringify({ phase, reason }))
}
function binding(value: unknown, runPid: number, endpoint: string): NativeSocketBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('native-peer', 'binding-shape')
  const x = value as Record<string, unknown>
  if (x.type !== 'native-socket-binding' || x.schema !== 1 || x.runPid !== runPid || x.uid !== process.getuid?.() ||
      ['tuiPid', 'peerPid'].some(key => !Number.isSafeInteger(x[key]) || Number(x[key]) <= 0) ||
      ['tuiFd', 'peerFd'].some(key => !Number.isSafeInteger(x[key]) || Number(x[key]) < 0) ||
      ['runBirth', 'tuiBirth', 'peerBirth'].some(key => typeof x[key] !== 'string' || !/^\d+:\d+$/u.test(x[key] as string)) ||
      ['tuiSocket', 'peerSocket', 'device', 'inode'].some(key => typeof x[key] !== 'string' || !/^\d+$/u.test(x[key] as string)) ||
      x.tuiSocket === '0' || x.peerSocket === '0' || typeof x.endpoint !== 'string' || !x.endpoint.startsWith('/') ||
      endpoint !== '' && x.endpoint !== endpoint) throw failure('native-peer', 'binding-target')
  const { type: _type, fd: _fd, ...result } = x
  return result as NativeSocketBinding
}

/** OS-bound connection to the original Run's peer, reusing that verified FD for all RPC. */
export async function openNativeSocketChannel(runPid: number, endpoint: string, signal: AbortSignal): Promise<NativeSocketChannel> {
  signal.throwIfAborted()
  if (process.platform !== 'darwin') throw failure('native-peer', 'os-peer-observation-unsupported')
  const executable = fileURLToPath(new URL('./native-socket-peer-darwin', import.meta.url))
  const child = spawn(executable, [String(runPid), endpoint, process.execPath, resolveCoreBinPath('native-socket-transport.mjs')],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  let pending = '', observed: NativeSocketBinding | undefined, protocolFailure: AgentMuxError | undefined
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const rpc = new JSONRPCClient(async request => {
    if (protocolFailure) throw protocolFailure
    child.stdin.write(JSON.stringify(request) + '\n')
  })
  const fail = (error: AgentMuxError) => { protocolFailure ??= error; rejectReady(error); rpc.rejectAllPendingRequests(error.message) }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  child.stdout.on('data', (bytes: Buffer) => {
    try {
      pending += decoder.decode(bytes, { stream: true })
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw failure('native-rpc', 'frame-memory-limit')
      for (let end; (end = pending.indexOf('\n')) !== -1;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        const frame = JSON.parse(line) as Record<string, unknown>
        if (!observed) observed = binding(frame, runPid, endpoint)
        else if (frame.type === 'native-socket-ready' && frame.schema === 1) resolveReady()
        else if (Object.hasOwn(frame, 'id') && !Object.hasOwn(frame, 'method')) {
          const error = frame.error as { code?: unknown; message?: unknown } | undefined
          if (Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error') ||
              frame.jsonrpc !== undefined && frame.jsonrpc !== '2.0' ||
              error !== undefined && (!error || typeof error !== 'object' || !Number.isSafeInteger(error.code) || typeof error.message !== 'string')) {
            throw failure('native-rpc', 'response-shape')
          }
          rpc.receive(frame as unknown as JSONRPCResponse)
        }
        // Native notifications and ServerRequests do not settle an Input RPC.
      }
    } catch { fail(failure('native-rpc', 'protocol-frame')) }
  })
  let diagnostics = ''
  child.stderr.on('data', (bytes: Buffer) => {
    // C helper errors are a bounded machine record, never a display-text classification.
    diagnostics += bytes.toString('utf8')
    for (let end; (end = diagnostics.indexOf('\n')) !== -1;) {
      const line = diagnostics.slice(0, end); diagnostics = diagnostics.slice(end + 1)
      try {
        const x = JSON.parse(line) as { code?: unknown; phase?: unknown; errno?: unknown }
        if (x.code === 'NATIVE_SOCKET_PEER_UNCONFIRMED' && typeof x.phase === 'string' && /^[a-z-]{1,64}$/u.test(x.phase)) fail(failure('native-peer', x.phase))
      } catch { /* Unstructured diagnostics never establish an owner or input result. */ }
    }
    if (diagnostics.length > 4096) diagnostics = '' // Only the bounded observer record has a contract.
  })
  child.once('error', () => fail(failure('native-peer', 'observer-start')))
  child.stdin.on('error', () => fail(failure('native-rpc', 'request-write')))
  const closed = new Promise<void>(resolve => child.once('close', () => { fail(failure('native-rpc', 'connection-closed')); resolve() }))
  const abort = () => { fail(failure('native-peer', 'observation-cancelled')); child.kill('SIGTERM') }
  signal.addEventListener('abort', abort, { once: true })
  const close = async () => {
    signal.removeEventListener('abort', abort)
    child.stdin.end()
    const term = setTimeout(() => child.kill('SIGTERM'), 500)
    const kill = setTimeout(() => child.kill('SIGKILL'), 1_000) // Only the Core-owned observer, never TUI/backend.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([closed, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(failure('native-cleanup', 'observer-exit-unconfirmed')), 1_500)
    })]) } finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline) }
  }
  try {
    await ready; signal.throwIfAborted()
    const current = observed!
    const tui = await openNativeProcessImage(current.tuiPid, signal)
    const imageIdentity = tui.identity
    try {
      const peer = await openNativeProcessImage(current.peerPid, signal)
      try {
        if (tui.identity !== peer.identity) throw failure('native-actor', 'peer-image-mismatch')
        await tui.assertCurrent(signal); await peer.assertCurrent(signal)
      } finally { await peer.file.close() }
    } finally { await tui.file.close() }
    signal.removeEventListener('abort', abort)
    return { binding: current, sourceId: nativeSocketSourceId(current),
      request: async (method, params, id = randomUUID(), requestSignal = AbortSignal.timeout(8_000)) => {
        requestSignal.throwIfAborted()
        let abort!: () => void
        try {
          const response = await Promise.race([rpc.requestAdvanced({ jsonrpc: '2.0', method, params, id }), new Promise<never>((_, reject) => {
            abort = () => reject(failure('native-rpc', 'reply-wait-cancelled'))
            requestSignal.addEventListener('abort', abort, { once: true })
            if (requestSignal.aborted) abort()
          })])
          if (protocolFailure) throw protocolFailure
          return response
        } finally { requestSignal.removeEventListener('abort', abort) }
      },
      notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'),
      assertCurrent: async currentSignal => {
        if (protocolFailure) throw protocolFailure
        const checked = await runProcess(executable, ['--verify', String(current.runPid), String(current.tuiPid), String(current.peerPid),
          String(current.tuiFd), String(current.peerFd), current.tuiSocket, current.peerSocket, current.runBirth, current.tuiBirth, current.peerBirth,
          current.endpoint, `${current.device}:${current.inode}`], { signal: currentSignal, timeoutMs: 2000, maxOutputBytes: 4096 })
        if (checked.exitCode !== 0 || checked.stdout !== '{"type":"native-socket-current","schema":1}\n') {
          let reason = 'original-association-unconfirmed'
          try { const record = JSON.parse(checked.stderr) as { code?: unknown; phase?: unknown }
            if (record.code === 'NATIVE_SOCKET_PEER_UNCONFIRMED' && typeof record.phase === 'string' && /^[a-z-]{1,64}$/u.test(record.phase)) reason = record.phase
          } catch { /* Observation failure is unknown, never current authority. */ }
          throw failure('native-current-peer', reason)
        }
        for (const pid of [current.tuiPid, current.peerPid]) {
          const image = await openNativeProcessImage(pid, currentSignal)
          try { if (image.identity !== imageIdentity) throw failure('native-current-peer', 'original-image-changed') }
          finally { await image.file.close() }
        }
      }, close }
  } catch (error) { await close(); throw error }
}
