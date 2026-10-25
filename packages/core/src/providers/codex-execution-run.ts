import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentToolContextState } from '../agent-tool-context.js'
import type { AgentExecutionHelperContext } from '../agent-execution-helper.js'
import { runAgentExecutionHelper, type AgentExecutionHelperIo } from '../agent-execution-helper-run.js'
import { buildCodexNativeExecutorLaunchSpec, parseCodexExecutionMessage, parseCodexExecutionServerMessage } from './codex-execution-protocol.js'

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateCodexExecutionRunConfiguration(value: unknown): asserts value is AgentExecutionHelperContext {
  if (!object(value) || value.providerId !== 'codex' || !['frontend', 'executor'].includes(value.role as string) || !text(value.bindingId) || !text(value.createOperationId) || !text(value.workspacePath) || !isAbsolute(value.workspacePath) || !text(value.journalDirectory) || !isAbsolute(value.journalDirectory) || !text(value.executable) || !isAbsolute(value.executable)) throw new Error('Invalid fixed native execution helper configuration')
  if (value.agentSessionId !== undefined && !text(value.agentSessionId)) throw new Error('The original Agent Session identity must be exact when supplied')
  if (value.role === 'executor' && (!object(value.grant) || value.grant.scope !== 'host-user' || value.grant.bindingId !== value.bindingId)) throw new Error('An exact Host-user resource grant is required for the native executor')
  if (value.role === 'executor' ? !text(value.journalIdentity) : value.journalIdentity !== undefined) throw new Error('The original executor journal identity is required only for its executor helper')
}

export function parseCodexExecutionRunArguments(args: readonly string[]): AgentExecutionHelperContext {
  if (args.length !== 2 || args[0] !== '--agentmux-execution-helper') throw new Error('The native execution helper requires its explicit runner arguments')
  const value: unknown = JSON.parse(args[1]!)
  validateCodexExecutionRunConfiguration(value)
  return value
}

export async function runCodexExecutionHelper(context: AgentExecutionHelperContext, io: AgentExecutionHelperIo): Promise<{ close(): Promise<void> }> {
  validateCodexExecutionRunConfiguration(context)
  return await runAgentExecutionHelper(context, io, value => {
    const spec = buildCodexNativeExecutorLaunchSpec({ executable: value.executable, cwd: value.workspacePath, concurrentRequests: 32 })
    return { parse: parseCodexExecutionMessage, parseServer: parseCodexExecutionServerMessage,
      executor: { command: spec.program, args: spec.args, cwd: spec.cwd,
        env: { AGENTMUX_TOOL_CONTEXT: 'unconfigured' satisfies AgentToolContextState,
          AGENTMUX_AGENT_SESSION_ID: value.agentSessionId, AGENTMUX_AGENT_CAPABILITY: undefined } } }
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Only the explicit packaged runner owns startup. EOF merely detaches machine
  // observation; it is not permission to kill an executor or its native child.
  void (async () => {
    const context = parseCodexExecutionRunArguments(process.argv.slice(2))
    await runCodexExecutionHelper(context, { input: process.stdin, output: process.stdout })
  })().catch(() => {
    process.stdout.write(JSON.stringify({ type: 'diagnostic', scope: 'helper', code: 'NATIVE_EXECUTION_HELPER_START_FAILED' }) + '\n')
    process.exitCode = 1
  })
}
