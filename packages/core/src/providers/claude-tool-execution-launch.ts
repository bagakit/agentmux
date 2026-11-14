import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AgentMuxError } from '../errors.js'
import { durableWriteFile } from '../durable-write.js'
import type { AgentLaunchPlan } from '../types.js'
import type { AgentToolExecutionLaunchContext } from '../agent-tool-execution.js'
import { classifyExecutable } from '../executable-probe.js'
import { agentControlFailureCode, registerAgentExecutionInvocation } from '../agent-execution-rpc-relay.js'

import { inspectClaudeHookSettings } from './claude-hook-activation.js'
import { prepareClaudeExecutionPolicy } from './claude-execution-policy.js'
export const CLAUDE_EXECUTION_MCP_SERVER = 'amux_exec'
import { claudeLaunchValueOptions as valueOptions } from './claude-launch-options.js'

/** Resolve this Host's exact executable; native protocol and permissions belong to execution. */
export async function resolveClaudeExecutionExecutable(command: string, options: { env: Readonly<NodeJS.ProcessEnv>; workspacePath: string }): Promise<string> {
  const candidates = isAbsolute(command) || command.includes('/') ? [resolve(options.workspacePath, command)]
    : (options.env.PATH ?? '').split(delimiter).map(directory => resolve(options.workspacePath, directory, command))
  for (const executable of candidates) {
    if ((await classifyExecutable(executable)).availability !== 'available') continue
    return executable
  }
  throw new Error('The selected Claude executable is unavailable on its original Host')
}

/** Keep native authentication, settings, hooks and resume identity. Only this launch uses the fixed tool binding. */
export async function prepareClaudeToolExecutionLaunch(plan: AgentLaunchPlan, context: AgentToolExecutionLaunchContext): Promise<AgentLaunchPlan> {
  const env = { ...process.env, ...plan.env }
  const executable = await resolveClaudeExecutionExecutable(plan.command, { env, workspacePath: context.launchWorkspacePath })
  const endpoint = new URL(context.url)
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname === '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Claude tools require the original loopback execution capability')
  const args = [...plan.args]
  // Native prompt footer is opaque, including strings that resemble CLI flags.
  let boundary = args.indexOf('--'); if (boundary < 0) boundary = args.length
  for (let i = 0; i < boundary; i++) {
    const arg = args[i]!, option = arg.split('=')[0]!
    if (['--remote', '--teleport', '--worktree', '-w'].includes(option)) throw new Error('This launch selects a different tool environment; choose one original execution binding')
    if (valueOptions.has(option) && !arg.includes('=')) i++
  }
  let activation
  try { activation = await inspectClaudeHookSettings({ workspacePath: context.launchWorkspacePath, args, env }) }
  catch (cause) {
    const error = new AgentMuxError('The selected resource-tool route configuration is unconfirmed. Inspect the original Claude Hook settings before retrying this bound launch. ' + (cause instanceof Error ? cause.message : String(cause)), 'EXECUTION_ROUTING_CONFIGURATION_UNCONFIRMED')
    error.cause = cause
    throw error
  }
  if (activation.active === false) throw new Error('Claude settings disable this bound launch’s resource tools. Enable its Hooks for this launch or choose local tools.')
  let url = context.url
  if (context.invocation) {
    try { url = await registerAgentExecutionInvocation(context.url, context.invocation) }
    catch (error) { url += '/unverified/' + agentControlFailureCode(error) }
  }
  const policy = await prepareClaudeExecutionPolicy({ workspacePath: context.launchWorkspacePath, bindingId: context.binding.bindingId, serverName: CLAUDE_EXECUTION_MCP_SERVER })
  const mcp = JSON.stringify({ mcpServers: { [CLAUDE_EXECUTION_MCP_SERVER]: { type: 'ws', url } } })
  const note = `Your project and tools are on Host ${JSON.stringify(context.binding.resourceHostId)}, in ${JSON.stringify(context.binding.workspacePath)}. Your original file and command tools are routed to that resource Host by the execution binding. Their paths and command cwd belong to that Host. Your Agent process cwd is ${JSON.stringify(context.launchWorkspacePath)}. Read the resource project's CLAUDE.md through its Read tool before working. Existing native permission decisions still apply to MCP calls; connection does not grant blanket tool approval.`
  const lastOption = (flag: string) => {
    let last = -1
    for (let index = 0; index < boundary; index++) {
      const arg = args[index]!, option = arg.split('=')[0]!
      if (option === flag) last = index
      if (valueOptions.has(option) && !arg.includes('=')) index++
    }
    return last
  }
  // Native MCP config is variadic and a later occurrence replaces the list.
  // Contribute last to the effective list, preserving its existing inputs.
  const list = (flag: string, value: string) => {
    const at = lastOption(flag)
    if (at < 0) { args.unshift(flag, value); boundary += 2; return }
    const original = args[at]!
    if (original !== flag) { args.splice(at, 1, flag, original.slice(flag.length + 1)); boundary++ }
    let end = at + 1
    while (end < boundary && !args[end]!.startsWith('-')) end++
    // Native list merging uses the last same-name server. The bound private
    // endpoint is this launch's exact target, after any user-provided entries.
    args.splice(end, 0, value); boundary++
  }
  list('--mcp-config', mcp)
  // Unlike MCP config, plugin-dir is single-valued and repeatable. A second
  // path after the same flag is a positional argument, not another plugin.
  args.splice(boundary, 0, '--plugin-dir', policy); boundary += 2
  const promptAt = lastOption('--append-system-prompt')
  const fileAt = lastOption('--append-system-prompt-file')
  if (promptAt >= 0) {
    const equal = args[promptAt]!.startsWith('--append-system-prompt=')
    const original = equal ? args[promptAt]!.slice('--append-system-prompt='.length) : args[promptAt + 1]!
    args.splice(promptAt, equal ? 1 : 2, '--append-system-prompt', note + '\n\n' + original)
  } else if (fileAt >= 0) {
    const equal = args[fileAt]!.startsWith('--append-system-prompt-file=')
    const original = equal ? args[fileAt]!.slice('--append-system-prompt-file='.length) : args[fileAt + 1]!
    const text = note + '\n\n' + await readFile(resolve(context.launchWorkspacePath, original), 'utf8')
    const file = join(policy, 'context-' + createHash('sha256').update(text).digest('hex') + '.txt')
    await durableWriteFile(file, text, { mode: 0o600 })
    args.splice(fileAt, equal ? 1 : 2, '--append-system-prompt-file', file)
  } else args.unshift('--append-system-prompt', note)
  return { ...plan, command: executable, args }
}
