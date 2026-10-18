import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { CODEX_NATIVE_TOKEN_ENV, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV, openCodexFrontendControl } from './codex-managed-frontend.js'
import type { AgentTerminalFrontendObservation } from '../agent-terminal-frontend.js'
import { resolve } from 'node:path'
import { nativeProcessTcpListeners } from '../agent-native-process.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'
import { codexDiagnosticStream, formatCodexManagedDiagnostic } from './codex-managed-diagnostics.js'

export { CODEX_NATIVE_TOKEN_ENV } from './codex-managed-frontend.js'
export type CodexManagedResume = { threadId: string; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'on-request' | 'never'; model?: string; cwd?: string }
export type CodexManagedRunPlan = { command: string; args: string[]; serverConfig: string[]; frontendArgs: string[]; resume?: CodexManagedResume }
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
  let resumeConnection: Awaited<ReturnType<typeof connectCodexNativeActor>> | undefined
  // Preserve the complete preparation diagnostic stream on this original Run, with backpressure.
  // Exact known credentials are masked even when the native process splits their bytes.
  const preparationDiagnostics = codexDiagnosticStream(diagnosticCredentials())
  const preparationDiagnosticsEnded = new Promise<void>(done => preparationDiagnostics.once('end', done))
  server.stderr?.pipe(preparationDiagnostics).pipe(process.stderr, { end: false })
  server.stderr?.once('close', () => preparationDiagnostics.end())
  if (!server.stderr) preparationDiagnostics.end()
  let serverError: Error | undefined
  server.once('error', error => { serverError = error })
  let frontend: AgentTerminalFrontendObservation = { frontendId: randomUUID(), state: 'starting', backendState: 'running', source: 'managed-process', observedAt: Date.now() }
  let control: Awaited<ReturnType<typeof openCodexFrontendControl>> | undefined
  const publish = (value: AgentTerminalFrontendObservation): void => { frontend = value; control?.publish(frontend) }
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    publish({ ...frontend, backendState: 'stopping', observedAt: Date.now() })
    tui?.kill('SIGTERM'); server.kill('SIGTERM')
  }
  const spawnTui = async (endpoint: string, args: string[], frontendId: string = randomUUID()): Promise<AgentTerminalFrontendObservation> => {
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
    const detached = (expectedId: string): boolean => frontend.frontendId === expectedId && frontend.state === 'detached'
    const operations = new Map<string, { request: string; result: Promise<AgentTerminalFrontendObservation> }>()
    control = await openCodexFrontendControl(token, { actorId, lifecycleOperationId, processId: process.pid }, {
      current: () => ({ ...frontend }),
      reconnect: request => {
        const key = JSON.stringify(request), previous = operations.get(request.operationId)
        if (previous) {
          if (previous.request !== key) throw new ManagedNativeLaunchError('The original frontend operation has another immutable target.')
          return previous.result
        }
        const result = (async () => {
          if (stopping || backendEnded || frontend.backendState !== 'running') throw new ManagedNativeLaunchError('The original backend is stopping or ended. Its Session is preserved.')
          if (!detached(request.expectedFrontendId)) throw new ManagedNativeLaunchError('The original frontend generation changed. Re-read this Session before reconnecting.')
          const connection = await connectCodexNativeActor(endpoint!, token, new AbortController().signal, 'agentmux_frontend_reconnect')
          try {
            const value = await connection.request('thread/read', { threadId: request.nativeSessionId, includeTurns: false })
            if (value?.thread?.id !== request.nativeSessionId || value.thread.canAcceptDirectInput !== true) throw new ManagedNativeLaunchError('The original loaded native thread is unconfirmed. No replacement was started.')
            if (stopping || backendEnded || !detached(request.expectedFrontendId)) throw new ManagedNativeLaunchError('The original frontend or backend changed before reconnect.')
            // The original argv can contain an already delivered prompt. Never replay it.
            const flags = plan.frontendArgs
            return await spawnTui(endpoint!, ['resume', request.nativeSessionId, ...flags])
          } finally { connection.dispose() }
        })()
        operations.set(request.operationId, { request: key, result })
        return result
      }
    })
    const deadline = Date.now() + 10_000
    while (!endpoint && !serverError && !backendEnded && Date.now() < deadline) {
      const listeners = await nativeProcessTcpListeners(process.pid, new AbortController().signal).catch(() => [])
      if (listeners.length > 1) throw new ManagedNativeLaunchError('The original native actor listener is ambiguous.')
      endpoint = listeners[0]?.endpoint
      if (!endpoint) await new Promise(resolve => setTimeout(resolve, 60))
    }
    if (!endpoint) {
      // This plan is already frozen. Never replace its actor with an embedded TUI.
      throw new ManagedNativeLaunchError('The original managed native actor did not publish its exact listener.')
    }
    if (plan.resume) {
      // Resolve CLI-relative cwd here, inside the original Run, never in the Core service process.
      const expected = { ...plan.resume, ...(plan.resume.cwd === undefined ? {} : { cwd: resolve(plan.resume.cwd) }),
        // The first native resume owns this option; a later TUI resume joins its loaded thread.
        ...(plan.frontendArgs.includes('--dangerously-bypass-hook-trust') ? { config: { bypass_hook_trust: true } } : {}) }
      let resumed: any
      try {
        resumeConnection = await connectCodexNativeActor(endpoint, token, new AbortController().signal, 'agentmux_managed_resume')
        resumed = await resumeConnection.request('thread/resume', { ...expected, excludeTurns: true })
      } catch (cause) {
        throw new ManagedNativeLaunchError('The original native resume request could not be confirmed before TUI start.', { cause })
      }
      const sandboxType = expected.sandbox === 'read-only' ? 'readOnly' : expected.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'
      if (resumed?.thread?.id !== expected.threadId || resumed.thread.canAcceptDirectInput !== true ||
          typeof resumed.thread.sessionId !== 'string' || !resumed.thread.sessionId ||
          expected.approvalPolicy !== undefined && resumed.approvalPolicy !== expected.approvalPolicy ||
          expected.sandbox !== undefined && resumed.sandbox?.type !== sandboxType ||
          expected.model !== undefined && resumed.model !== expected.model ||
          expected.cwd !== undefined && resumed.cwd !== expected.cwd) {
        throw new ManagedNativeLaunchError('The original native resume did not confirm its requested effective configuration before TUI start.')
      }
      // Keep this original subscription alive: TUI resumes the same loaded object, without overrides.
    }
    // The healthy TUI owns the screen. Background server logs must not corrupt its display.
    server.stderr?.unpipe(preparationDiagnostics); preparationDiagnostics.end(); server.stderr?.resume()
    await spawnTui(endpoint, plan.args, frontend.frontendId)
    // Frontend exit is an attachment fact. Only the backend/explicit Stop ends this Run.
    const ended = await backendExit
    if (ended.error) throw ended.error
    return ended.code
  } finally {
    resumeConnection?.dispose(); stop(); await control?.close()
    // Child exit can precede the last stderr bytes. Print the failure cause only after this tail.
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
