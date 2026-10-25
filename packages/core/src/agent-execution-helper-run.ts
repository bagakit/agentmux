import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { AgentExecutionHelperContext } from './agent-execution-helper.js'
import { AgentExecutionRpcResource } from './agent-execution-rpc-relay.js'
import { createAgentExecutionExecutor } from './agent-execution-executor.js'
import { AgentExecutionJournal } from './agent-execution-journal.js'
import { runAgentExecutionFrontend } from './agent-execution-frontend.js'
export type AgentExecutionHelperIo = { input: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown }; output: Writable }

export async function runAgentExecutionHelper(
  context: AgentExecutionHelperContext,
  io: AgentExecutionHelperIo,
  protocol: (context: AgentExecutionHelperContext) => import('./agent-execution-protocol.js').AgentExecutionProtocol,
): Promise<{ close(): Promise<void> }> {
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
    io.output.write(JSON.stringify({ type: 'diagnostic', scope: 'helper', code: 'NATIVE_EXECUTION_HELPER_OBSERVATION_UNCONFIRMED' }) + '\n', () => { diagnosticPending = false })
  }
  if (context.role === 'frontend') return await runAgentExecutionFrontend({ input: io.input, output: io.output, onError: diagnostic, ...(context.agentSessionId ? { agentSessionId: context.agentSessionId } : {}) })

  const journal = await AgentExecutionJournal.open(context.journalDirectory, context.journalIdentity)
  const stderr = createWriteStream(join(context.journalDirectory, 'native-executor.stderr.log'), { flags: 'a', mode: 0o600 })
  try { await once(stderr, 'open') } catch (error) { await journal.close(); throw error }
  stderr.on('error', diagnostic)
  const bindingId = context.bindingId, grant = context.grant ? { ...context.grant } : undefined
  const executor = createAgentExecutionExecutor({
    bindingId,
    journal,
    protocol: protocol(context),
    input: io.input,
    output: io.output,
    stderr,
    ...(context.agentSessionId ? { control: new AgentExecutionRpcResource(context.agentSessionId, diagnostic) } : {}),
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

