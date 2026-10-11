import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { nativeProcessTcpListeners } from '../agent-native-process.js'

export const CODEX_NATIVE_TOKEN_ENV = 'AGENTMUX_CODEX_ACTOR_TOKEN'
export type CodexManagedRunPlan = { command: string; args: string[]; serverConfig: string[] }

/** Only child lifecycle and TTY inheritance. Core/ctxmux remain the sole Run owner. */
export async function runCodexManaged(plan: CodexManagedRunPlan): Promise<number> {
  const token = process.env[CODEX_NATIVE_TOKEN_ENV]
  if (!token) throw new Error('The original native actor launch credential is missing.')
  const server = spawn(plan.command, [...plan.serverConfig, 'app-server', '--listen', 'ws://127.0.0.1:0',
    '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')],
  { cwd: process.cwd(), env: process.env, detached: false, stdio: ['ignore', 'ignore', 'pipe'] })
  let tui: ReturnType<typeof spawn> | undefined
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
      if (listeners.length > 1) throw new Error('The original native actor listener is ambiguous.')
      endpoint = listeners[0]?.endpoint
      if (!endpoint) await new Promise(resolve => setTimeout(resolve, 60))
    }
    if (!endpoint) {
      // This plan is already frozen. Never replace its actor with an embedded TUI.
      throw new Error('The original managed native actor did not publish its exact listener.')
    }
    tui = spawn(plan.command, ['--remote', endpoint, '--remote-auth-token-env', CODEX_NATIVE_TOKEN_ENV, ...plan.args],
      { cwd: process.cwd(), env: process.env, detached: false, stdio: 'inherit' })
    const child = tui
    return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))) })
  } finally { stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCodexManaged(JSON.parse(process.argv[2]!) as CodexManagedRunPlan) }
  catch { process.stderr.write('AgentMux could not prepare the original native actor launch.\n'); process.exitCode = 1 }
}
