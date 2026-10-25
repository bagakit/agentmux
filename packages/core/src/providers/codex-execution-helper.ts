import { fileURLToPath } from 'node:url'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { AgentExecutionHelperContext } from '../agent-execution-helper.js'
import { classifyExecutable } from '../executable-probe.js'
import { runProcess } from '../process-runner.js'
import type { AgentLaunchPlan } from '../types.js'
import { validateCodexExecutionRunConfiguration } from './codex-execution-run.js'

/** Qualify the actual Host invocation, not another helper's similarly named CLI. */
export async function qualifyCodexExecutionExecutable(command: string, options: { workspacePath?: string; env: Readonly<NodeJS.ProcessEnv> }): Promise<string> {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : (options.env.PATH ?? '').split(delimiter).map(directory => join(directory, command))
  let executable: string | undefined
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) && !options.workspacePath) throw new Error('The exact backend launch directory is required to resolve this native executable')
    const absolute = isAbsolute(candidate) ? candidate : resolve(options.workspacePath!, candidate)
    if ((await classifyExecutable(absolute)).availability === 'available') { executable = absolute; break }
  }
  if (!executable) throw new Error('The native executable is unavailable on this helper Host')
  // Stable CLI version protocol, not a screen/readiness heuristic. Only this
  // native release has qualified environment and exec-server transport contracts.
  const version = await runProcess(executable, ['--version'], { ...(options.workspacePath === undefined ? {} : { cwd: options.workspacePath }), env: options.env, timeoutMs: 2_000, maxOutputBytes: 4096 }).catch(() => null)
  if (!version || version.exitCode !== 0 || version.stderr || version.stdout.trim() !== 'codex-cli 0.165.0') throw new Error('The selected native executable is not qualified for this tool execution helper')
  return executable
}

/** Qualifies only this new helper operation; never restarts or replaces an Agent. */
export async function prepareCodexExecutionHelper(context: AgentExecutionHelperContext): Promise<AgentLaunchPlan> {
  const executable = await qualifyCodexExecutionExecutable(context.executable, { workspacePath: context.workspacePath, env: process.env })
  const configuration = { ...context, executable }
  validateCodexExecutionRunConfiguration(configuration)
  return {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./codex-execution-run.js', import.meta.url)), '--agentmux-execution-helper', JSON.stringify(configuration)],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}
