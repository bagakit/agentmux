import { isAbsolute, join, resolve } from 'node:path'
import { createClaudeExecutionOperations } from './claude-execution-operations.js'
import { pathToFileURL } from 'node:url'
import type { AgentExecutionHelperContext } from '../agent-execution-helper.js'
import { runAgentExecutionHelper, runAgentExecutionHelperCli, type AgentExecutionHelperIo } from '../agent-execution-helper-run.js'
import { parseClaudeExecutionMessage, parseClaudeExecutionServerMessage, projectClaudeExecutionResponse, buildClaudeNativeExecutorLaunchSpec } from './claude-execution-protocol.js'

export function parseClaudeExecutionRunArguments(args: readonly string[]): AgentExecutionHelperContext {
  if (args.length !== 2 || args[0] !== '--agentmux-execution-helper') throw new Error('Claude execution requires the original packaged helper arguments')
  const value = JSON.parse(args[1]!) as AgentExecutionHelperContext
  if (value.providerId !== 'claude' || !['frontend', 'executor'].includes(value.role) ||
      [value.bindingId, value.createOperationId, value.agentSessionId].some(item => typeof item !== 'string' || !item || item.includes('\0')) ||
      [value.workspacePath, value.journalDirectory, value.executable].some(item => typeof item !== 'string' || !isAbsolute(item))) throw new Error('Invalid fixed Claude execution helper identity')
  if (value.role === 'executor' && (value.grant?.scope !== 'host-user' || value.grant.bindingId !== value.bindingId || !value.journalIdentity)) throw new Error('Claude tools require the original resource grant and journal')
  return value
}

export function runClaudeExecutionHelper(context: AgentExecutionHelperContext, io: AgentExecutionHelperIo): Promise<{ close(): Promise<void> }> {
  parseClaudeExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify(context)])
  return runAgentExecutionHelper(context, io, value => ({
    parse: parseClaudeExecutionMessage, parseServer: parseClaudeExecutionServerMessage,
    projectResponse: projectClaudeExecutionResponse,
    concurrentConnections: true,
    ...createClaudeExecutionOperations({ workspacePath: value.workspacePath, outputDirectory: join(value.journalDirectory, 'shell-output'), ...(value.agentSessionId ? { agentSessionId: value.agentSessionId } : {}) }),
    executor: (() => { const spec = buildClaudeNativeExecutorLaunchSpec({ executable: value.executable, cwd: value.workspacePath }); return {
      command: spec.program, args: spec.args, cwd: spec.cwd, env: { AGENTMUX_TOOL_CONTEXT: 'unconfigured', AGENTMUX_AGENT_SESSION_ID: value.agentSessionId, AGENTMUX_AGENT_CAPABILITY: undefined }
    } })(),
  }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runAgentExecutionHelperCli(() => runClaudeExecutionHelper(parseClaudeExecutionRunArguments(process.argv.slice(2)), { input: process.stdin, output: process.stdout }))
    .then(() => process.exit(0), () => {
      process.stdout.write(JSON.stringify({ type: 'diagnostic', scope: 'helper', code: 'NATIVE_EXECUTION_HELPER_LIFECYCLE_FAILED' }) + '\n', () => process.exit(1))
    })
}
