import { mintObjectId } from '../object-id.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { CODEX_NATIVE_TOKEN_ENV, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV, openCodexFrontendControl } from './codex-managed-frontend.js'
import type { AgentTerminalFrontendObservation, AgentTerminalInitialization } from '../agent-terminal-frontend.js'
import { resolve } from 'node:path'
import { nativeProcessTcpListeners } from '../agent-native-process.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'
import { codexDiagnosticStream, formatCodexManagedDiagnostic } from './codex-managed-diagnostics.js'

export { CODEX_NATIVE_TOKEN_ENV } from './codex-managed-frontend.js'
export type CodexManagedThreadConfiguration = { sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'on-request' | 'never'; model?: string; cwd?: string }
export type CodexManagedResume = CodexManagedThreadConfiguration & { threadId: string }
export type CodexManagedRunPlan = { command: string; serverConfig: string[]; frontendArgs: string[] } &
  ({ create: CodexManagedThreadConfiguration; resume?: never } | { resume: CodexManagedResume; create?: never })
const INITIALIZATION_OBSERVATION_MS = 8_000
class ManagedNativeLaunchError extends Error {}
const diagnosticCredentials = (): string[] => [process.env[CODEX_NATIVE_TOKEN_ENV], process.env.AGENTMUX_HOOK_TOKEN,
  process.env.AGENTMUX_AGENT_CAPABILITY].filter((value): value is string => Boolean(value))

/** Child lifecycle, exact native resume preparation and TTY inheritance; Core/ctxmux own the Run. */
export async function runCodexManaged(plan: CodexManagedRunPlan): Promise<number> {
  const token = process.env[CODEX_NATIVE_TOKEN_ENV]
  const actorId = process.env[CODEX_ACTOR_ID_ENV], lifecycleOperationId = process.env[CODEX_ACTOR_LIFECYCLE_ENV]
  if (!token || !actorId || !lifecycleOperationId) throw new ManagedNativeLaunchError('The original native actor launch credential is missing.')
  const server = spawn(plan.command, [...plan.serverConfig, 'app-server', '--listen', 'ws://127.0.0.1:0',
    '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
  { cwd: process.cwd(), env: process.env, detached: false, stdio: ['ignore', 'ignore', 'pipe'] })
  // Own the exit listener before the first await; signal exits leave exitCode null.
  let backendEnded = false
  const backendExit = new Promise<{ code: number; error?: Error }>(resolve => {
    server.once('error', error => { backendEnded = true; resolve({ code: 1, error }) })
    server.once('exit', (code, signal) => { backendEnded = true; resolve({ code: code ?? (signal ? 1 : 0) }) })
  })
  let tui: ReturnType<typeof spawn> | undefined
  let nativeConnection: Awaited<ReturnType<typeof connectCodexNativeActor>> | undefined
  const lifetime = new AbortController()
  let initialization: AgentTerminalInitialization = { lifecycleOperationId, phase: 'preparing',
    native: { state: plan.resume ? 'unknown' : 'not-created' } }
  let initializationPending: Promise<void> | undefined, nativeRequested = false, nativeSessionId: string | undefined
  let initializationStep: NonNullable<AgentTerminalInitialization['failure']>['step'] = 'connection'
  // Preserve the complete preparation diagnostic stream on this original Run, with backpressure.
  // Exact known credentials are masked even when the native process splits their bytes.
  const preparationDiagnostics = codexDiagnosticStream(diagnosticCredentials())
  const preparationDiagnosticsEnded = new Promise<void>(done => preparationDiagnostics.once('end', done))
  server.stderr?.pipe(preparationDiagnostics).pipe(process.stderr, { end: false })
  server.stderr?.once('close', () => preparationDiagnostics.end())
  if (!server.stderr) preparationDiagnostics.end()
  let serverError: Error | undefined
  server.once('error', error => { serverError = error })
  let frontend: AgentTerminalFrontendObservation = { frontendId: mintObjectId(), state: 'starting', backendState: 'running', source: 'managed-process', observedAt: Date.now() }
  let control: Awaited<ReturnType<typeof openCodexFrontendControl>> | undefined
  const publish = (value: AgentTerminalFrontendObservation): void => { frontend = { ...value, initialization }; control?.publish(frontend) }
  const setInitialization = (value: AgentTerminalInitialization): void => {
    if (stopping || backendEnded) return
    initialization = value; publish({ ...frontend, observedAt: Date.now() })
  }
  const failure = (error: unknown): NonNullable<AgentTerminalInitialization['failure']> => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    let message = error instanceof Error ? error.message : String(error)
    for (const credential of diagnosticCredentials()) message = message.split(credential).join('[redacted]')
    return { step: initializationStep, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}), message: message.slice(-4096) || 'Native initialization is unconfirmed.' }
  }
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    lifetime.abort()
    publish({ ...frontend, backendState: 'stopping', observedAt: Date.now() })
    tui?.kill('SIGTERM'); server.kill('SIGTERM')
  }
  const spawnTui = async (endpoint: string, args: string[], frontendId: string = mintObjectId()): Promise<AgentTerminalFrontendObservation> => {
    publish({ frontendId, state: 'starting', backendState: 'running', source: 'managed-process', observedAt: Date.now() })
    const child = spawn(plan.command, ['--remote', endpoint, '--remote-auth-token-env', CODEX_NATIVE_TOKEN_ENV, ...args],
      { cwd: process.cwd(), env: process.env, detached: false, stdio: ['inherit', 'inherit', 'pipe'] })
    // Diagnostics explain this exact child generation; exit facts alone control its lifecycle.
    // Keep the complete original bytes in the Run's PTY, with stream backpressure, while
    // retaining only a small tail for the existing public frontend message contract.
    let diagnosticBytes = Buffer.alloc(0)
    child.stderr?.on('data', (bytes: Buffer) => {
      diagnosticBytes = Buffer.concat([diagnosticBytes, bytes]).subarray(-16_384)
    })
    child.stderr?.pipe(process.stderr, { end: false })
    const diagnostic = (): { message?: string } => {
      const message = stripVTControlCharacters(diagnosticBytes.toString('utf8')).trim().slice(-4096)
      return message ? { message } : {}
    }
    tui = child
    child.once('exit', (code, signal) => {
      if (tui !== child) return
      tui = undefined
      publish({ frontendId, state: 'detached', backendState: stopping ? 'stopping' : 'running', source: 'managed-process', observedAt: Date.now(),
        ...(code === null ? {} : { exitCode: code }), ...(signal ? { exitSignal: signal } : {}), ...diagnostic() })
    })
    child.once('close', () => {
      // exit may precede the last pipe bytes. Never amend a newer frontend with this tail.
      if (frontend.frontendId === frontendId && frontend.state === 'detached' && diagnosticBytes.length > 0) {
        publish({ ...frontend, ...diagnostic(), observedAt: Date.now() })
      }
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', error => {
      if (tui === child) { tui = undefined; publish({ frontendId, state: 'detached', backendState: 'running', source: 'managed-process', observedAt: Date.now(), message: error.message }) }
      reject(error)
    }) })
    publish({ frontendId, state: 'attached', backendState: 'running', source: 'managed-process', observedAt: Date.now() })
    return { ...frontend }
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    let endpoint: string | undefined
    const live = (): boolean => !stopping && !backendEnded
    const exact = (expectedId: string): boolean => frontend.frontendId === expectedId
    const detached = (expectedId: string): boolean => exact(expectedId) && frontend.state === 'detached'
    const locateEndpoint = async (): Promise<string> => {
      if (endpoint) return endpoint
      const deadline = Date.now() + 10_000
      while (live() && !serverError && Date.now() < deadline) {
        const listeners = await nativeProcessTcpListeners(process.pid, lifetime.signal).catch(() => [])
        if (listeners.length > 1) throw new ManagedNativeLaunchError('The original native actor listener is ambiguous.')
        if (listeners[0]) { endpoint = listeners[0].endpoint; return endpoint }
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      throw new ManagedNativeLaunchError('The original managed native actor did not publish its exact listener.')
    }
    const initializedFrontend = (): Promise<AgentTerminalFrontendObservation> => spawnTui(endpoint!, ['resume', nativeSessionId!, ...plan.frontendArgs], frontend.frontendId)
    const beginInitialization = (): Promise<void> => {
      if (initializationPending) return initializationPending
      if (nativeRequested || nativeSessionId || !live()) return Promise.resolve()
      const pending = (async () => {
        try {
          initializationStep = 'connection'
          setInitialization({ lifecycleOperationId, phase: 'preparing', native: { state: plan.resume ? 'unknown' : 'not-created' } })
          const address = await locateEndpoint()
          nativeConnection?.dispose()
          nativeConnection = await connectCodexNativeActor(address, token, lifetime.signal, 'agentmux_managed_initialization', { retainPendingInitialization: true })
          // Read-only preflight may be retried before any native creation request exists.
          initializationStep = 'preflight'
          const account = await nativeConnection.request('account/read', { refreshToken: false }, { retainPending: true })
          if (typeof account?.requiresOpenaiAuth !== 'boolean' || account.requiresOpenaiAuth && !account.account) {
            throw new ManagedNativeLaunchError('The native account preflight did not confirm its required authentication.')
          }
          if (!live()) return
          const options = plan.resume ?? plan.create
          const expected = { ...options, cwd: resolve(options.cwd ?? process.cwd()),
            ...(plan.frontendArgs.includes('--dangerously-bypass-hook-trust') ? { config: { bypass_hook_trust: true } } : {}) }
          nativeRequested = true
          initializationStep = 'native-session'
          setInitialization({ lifecycleOperationId, phase: 'creating', native: { state: 'unknown' } })
          // This one native request is retained even after an observer times out.
          // There is no thread/start idempotency key; retrying a reader cannot repeat it.
          const prepared = await nativeConnection.request(plan.resume ? 'thread/resume' : 'thread/start',
            { ...expected, ...(plan.resume ? { excludeTurns: true } : { threadSource: 'user' }) }, { retainPending: true }).catch(error => {
            // A settled resume rejection may follow loading the original thread.
            // Continuing this exact resume rejoins that backend's object; it does
            // not prove not-applied. Creation and uncertain transport stay latched.
            if (plan.resume && error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) nativeRequested = false
            throw error
          })
          if (!live()) return
          const id = prepared?.thread?.id
          const sandboxType = expected.sandbox === 'read-only' ? 'readOnly' : expected.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'
          if (typeof id !== 'string' || !id || plan.resume && id !== plan.resume.threadId ||
            prepared.thread.canAcceptDirectInput !== true || typeof prepared.thread.sessionId !== 'string' || !prepared.thread.sessionId ||
            expected.approvalPolicy !== undefined && prepared.approvalPolicy !== expected.approvalPolicy ||
            expected.sandbox !== undefined && prepared.sandbox?.type !== sandboxType ||
            expected.model !== undefined && prepared.model !== expected.model || prepared.cwd !== expected.cwd) {
            throw new ManagedNativeLaunchError('The original native bootstrap did not confirm its exact object and effective configuration.')
          }
          nativeSessionId = id
          setInitialization({ lifecycleOperationId, phase: 'ready', native: { state: 'confirmed', sessionId: id } })
          // Keep the original native connection alive and never let the TUI carry input.
          server.stderr?.unpipe(preparationDiagnostics); preparationDiagnostics.end(); server.stderr?.resume()
          initializationStep = 'frontend'
          await initializedFrontend()
        } catch (error) {
          if (!live()) return
          if (!nativeRequested) { nativeConnection?.dispose(); nativeConnection = undefined }
          setInitialization({ lifecycleOperationId, phase: nativeSessionId ? 'ready' : nativeRequested ? 'unknown' : 'failed',
            native: nativeSessionId ? { state: 'confirmed', sessionId: nativeSessionId } : { state: nativeRequested || plan.resume ? 'unknown' : 'not-created' },
            failure: failure(error) })
        }
      })()
      initializationPending = pending
      void pending.finally(() => { if (initializationPending === pending) initializationPending = undefined })
      return pending
    }
    const observeInitialization = async (): Promise<AgentTerminalFrontendObservation> => {
      const pending = beginInitialization()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(() => {
          if (live() && initialization.phase !== 'ready' && initialization.phase !== 'failed') {
            setInitialization({ ...initialization, phase: 'unknown', failure: { step: initializationStep,
              code: 'AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED',
              message: 'The original initialization response is unconfirmed. Its result remains observed; no native request or input was repeated.' } })
          }
          resolve()
        }, INITIALIZATION_OBSERVATION_MS) })])
      } finally { if (timer) clearTimeout(timer) }
      return { ...frontend }
    }
    type Operation = { request: string; result: Promise<AgentTerminalFrontendObservation>; applied: boolean; failed: boolean }
    const operations = new Map<string, Operation>()
    control = await openCodexFrontendControl(token, { actorId, lifecycleOperationId, processId: process.pid }, {
      current: () => ({ ...frontend, initialization }),
      reconnect: request => {
        const key = JSON.stringify(request), previous = operations.get(request.operationId)
        if (previous && previous.request !== key) throw new ManagedNativeLaunchError('The original frontend operation has another immutable target.')
        if (request.target.kind === 'initialization') {
          if (request.target.lifecycleOperationId !== lifecycleOperationId) throw new ManagedNativeLaunchError('The original initialization belongs to another lifecycle.')
          if (!previous && !exact(request.expectedFrontendId)) throw new ManagedNativeLaunchError('The original frontend generation changed. Re-read this Session before reconnecting.')
          // Join an outstanding request, or continue preflight / a settled rejected
          // exact resume. Unknown creation and late results keep the original latch.
          const result = observeInitialization()
          operations.set(request.operationId, { request: key, result, applied: nativeRequested, failed: false })
          return result
        }
        if (previous && (previous.applied || !previous.failed)) return previous.result
        const operation: Operation = { request: key, result: Promise.resolve(frontend), applied: false, failed: false }
        const target = request.target
        operation.result = (async () => {
          if (!live() || frontend.backendState !== 'running') throw new ManagedNativeLaunchError('The original backend is stopping or ended. Its Session is preserved.')
          if (!detached(request.expectedFrontendId)) throw new ManagedNativeLaunchError('The original frontend generation changed. Re-read this Session before reconnecting.')
          if (!nativeSessionId || target.nativeSessionId !== nativeSessionId) throw new ManagedNativeLaunchError('The original initialized native target is unconfirmed. No replacement was started.')
          const connection = await connectCodexNativeActor(await locateEndpoint(), token, lifetime.signal, 'agentmux_frontend_reconnect')
          try {
            const value = await connection.request('thread/read', { threadId: target.nativeSessionId, includeTurns: false })
            if (value?.thread?.id !== target.nativeSessionId || value.thread.canAcceptDirectInput !== true) throw new ManagedNativeLaunchError('The original loaded native thread is unconfirmed. No replacement was started.')
            if (!live() || !detached(request.expectedFrontendId)) throw new ManagedNativeLaunchError('The original frontend or backend changed before reconnect.')
            operation.applied = true
            return await spawnTui(endpoint!, ['resume', target.nativeSessionId, ...plan.frontendArgs])
          } finally { connection.dispose() }
        })().catch(error => { operation.failed = true; throw error })
        operations.set(request.operationId, operation)
        return operation.result
      }
    })
    void observeInitialization()
    // Bootstrap and frontend failures do not end this original, still healthy backend.
    const ended = await backendExit
    if (ended.error) throw ended.error
    return ended.code
  } finally {
    nativeConnection?.dispose(); stop(); await control?.close()
    await preparationDiagnosticsEnded
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCodexManaged(JSON.parse(process.argv[2]!) as CodexManagedRunPlan) }
  catch (error) {
    const diagnostic = error instanceof ManagedNativeLaunchError ? error : new Error('AgentMux could not prepare the original native actor launch.', { cause: error })
    process.stderr.write(formatCodexManagedDiagnostic(diagnostic, diagnosticCredentials()) + '\n'); process.exitCode = 1
  }
}
