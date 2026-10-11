import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { nativeProcessTcpListeners } from '../agent-native-process.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'

export const CODEX_NATIVE_TOKEN_ENV = 'AGENTMUX_CODEX_ACTOR_TOKEN'
export type CodexManagedResume = { threadId: string; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'on-request' | 'never'; model?: string; cwd?: string }
export type CodexManagedRunPlan = { command: string; args: string[]; serverConfig: string[]; resume?: CodexManagedResume }
class ManagedNativeLaunchError extends Error {}

/** Child lifecycle, exact native resume preparation and TTY inheritance; Core/ctxmux own the Run. */
export async function runCodexManaged(plan: CodexManagedRunPlan): Promise<number> {
  const token = process.env[CODEX_NATIVE_TOKEN_ENV]
  if (!token) throw new ManagedNativeLaunchError('The original native actor launch credential is missing.')
  const server = spawn(plan.command, [...plan.serverConfig, 'app-server', '--listen', 'ws://127.0.0.1:0',
    '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
  { cwd: process.cwd(), env: process.env, detached: false, stdio: ['ignore', 'ignore', 'pipe'] })
  let tui: ReturnType<typeof spawn> | undefined
  let resumeConnection: Awaited<ReturnType<typeof connectCodexNativeActor>> | undefined
  // Drain native diagnostics without mixing server output into the terminal or public receipts.
  server.stderr?.resume()
  let serverError: Error | undefined
  server.once('error', error => { serverError = error })
  const stop = (): void => { tui?.kill('SIGTERM'); server.kill('SIGTERM') }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    const deadline = Date.now() + 10_000
    let endpoint: string | undefined
    while (!endpoint && !serverError && server.exitCode === null && Date.now() < deadline) {
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
      const expected = { ...plan.resume, ...(plan.resume.cwd === undefined ? {} : { cwd: resolve(plan.resume.cwd) }) }
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
    tui = spawn(plan.command, ['--remote', endpoint, '--remote-auth-token-env', CODEX_NATIVE_TOKEN_ENV, ...plan.args],
      { cwd: process.cwd(), env: process.env, detached: false, stdio: 'inherit' })
    const child = tui
    return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))) })
  } finally { resumeConnection?.dispose(); stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCodexManaged(JSON.parse(process.argv[2]!) as CodexManagedRunPlan) }
  catch (error) { process.stderr.write((error instanceof ManagedNativeLaunchError ? error.message : 'AgentMux could not prepare the original native actor launch.') + '\n'); process.exitCode = 1 }
}
