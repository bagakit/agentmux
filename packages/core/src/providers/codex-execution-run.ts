import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { AgentToolContextState } from '../agent-tool-context.js'
import type { AgentExecutionHelperContext } from '../agent-execution-helper.js'
import { createAgentExecutionExecutor } from '../agent-execution-executor.js'
import { AgentExecutionJournal } from '../agent-execution-journal.js'
import { runCodexExecutionFrontend } from './codex-execution-frontend.js'
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

export async function runCodexExecutionHelper(
  context: AgentExecutionHelperContext,
  io: { input: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown }; output: Writable },
): Promise<{ close(): Promise<void> }> {
  validateCodexExecutionRunConfiguration(context)
  // Dedicated ctxmux helper PTY only. The ordinary Agent's terminal is never
  // parsed as a machine channel, and ready cannot precede disabling echo.
  if (!io.input.isTTY || !io.input.setRawMode) throw new Error('The native execution helper requires a dedicated raw-capable Runtime PTY')
  io.input.setRawMode(true)
  let diagnosticPending = false
  io.output.on('error', () => { /* The disconnected observer cannot receive a diagnostic. */ })
  const diagnostic = (): void => {
    // No raw error text, capability URL or native stderr enters the protocol.
    // A failed diagnostic write is an observation failure, not child shutdown.
    if (diagnosticPending) return
    diagnosticPending = true
    io.output.write(JSON.stringify({ type: 'diagnostic', code: 'NATIVE_EXECUTION_HELPER_OBSERVATION_UNCONFIRMED' }) + '\n', () => { diagnosticPending = false })
  }
  if (context.role === 'frontend') return await runCodexExecutionFrontend({ input: io.input, output: io.output, onError: diagnostic })

  const journal = await AgentExecutionJournal.open(context.journalDirectory, context.journalIdentity)
  const stderr = createWriteStream(join(context.journalDirectory, 'native-executor.stderr.log'), { flags: 'a', mode: 0o600 })
  try { await once(stderr, 'open') } catch (error) { await journal.close(); throw error }
  stderr.on('error', diagnostic)
  const bindingId = context.bindingId, grant = context.grant ? { ...context.grant } : undefined
  const spec = buildCodexNativeExecutorLaunchSpec({ executable: context.executable, cwd: context.workspacePath, concurrentRequests: 32 })
  const executor = createAgentExecutionExecutor({
    bindingId,
    journal,
    protocol: { parse: parseCodexExecutionMessage, parseServer: parseCodexExecutionServerMessage, executor: { command: spec.program, args: spec.args, cwd: spec.cwd,
      // Resource-side native children must never borrow the helper Host's user
      // route or an inherited Agent capability. The original Agent claim is
      // retained when known; it cannot substitute for a current authenticated route.
      env: { AGENTMUX_TOOL_CONTEXT: 'unconfigured' satisfies AgentToolContextState,
        AGENTMUX_AGENT_SESSION_ID: context.agentSessionId, AGENTMUX_AGENT_CAPABILITY: undefined } } },
    input: io.input,
    output: io.output,
    stderr,
    authorize: async target => {
      // This immutable launch grant came from the resource Core. Native frames
      // cannot choose another binding or turn their cwd into authorization.
      if (grant?.scope !== 'host-user' || grant.bindingId !== bindingId || target.bindingId !== bindingId) throw new Error('The exact resource binding was not authorized')
    },
    onError: diagnostic,
  })
  await new Promise<void>((resolveReady, reject) => io.output.write(JSON.stringify({ type: 'ready', bindingId: context.bindingId, journalIdentity: journal.identity }) + '\n', error => error ? reject(error) : resolveReady()))
  return { async close() { await executor.dispose(); await journal.close(); await new Promise<void>(resolveClosed => stderr.end(resolveClosed)) } }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Only the explicit packaged runner owns startup. EOF merely detaches machine
  // observation; it is not permission to kill an executor or its native child.
  void (async () => {
    const context = parseCodexExecutionRunArguments(process.argv.slice(2))
    await runCodexExecutionHelper(context, { input: process.stdin, output: process.stdout })
  })().catch(() => {
    process.stdout.write(JSON.stringify({ type: 'diagnostic', code: 'NATIVE_EXECUTION_HELPER_START_FAILED' }) + '\n')
    process.exitCode = 1
  })
}
