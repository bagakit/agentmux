#!/usr/bin/env node
import { writeCliResourceDocument } from './cli-resource-document.js'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import packageManifest from '../package.json' with { type: 'json' }
import {
  connectAgentMuxRpc, agentMuxRpcEndpoint,
  type AgentMuxRpcClient, type AgentMuxRpcMethod, type AgentMuxRpcParams,
  type AgentMuxRpcStreamMethod, type AgentMuxRpcStreamParams
} from './control-host.js'
import { forwardAgentMuxRpcStdio } from './agentmux-rpc-stdio.js'
import { isAgentMuxRpcMethod, isAgentMuxRpcStream } from './public-rpc.js'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from './public-rpc-wire.js'
import {
  AGENTMUX_CLI_COMMANDS, agentMuxCliArguments, agentMuxCliMatch,
  agentMuxCliRequestsHelp, parseAgentMuxCliInvocation
} from './agentmux-cli-commands.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from './agentmux-cli-help.js'
import { agentMuxPmoPlaybook } from './agentmux-pmo-playbook.js'

function write(value: unknown, stream: NodeJS.WriteStream = process.stdout, boundedReader = false): void {
  const line = boundedReader ? rpcEncode(value) : JSON.stringify(value) + '\n'
  // Synchronous RPC callbacks cannot await drain. Admit a legal frame even
  // above the pipe highWaterMark; cap actual pending bytes before enqueueing.
  if (boundedReader && stream.writableLength + Buffer.byteLength(line) > AGENTMUX_RPC_MAX_MESSAGE_BYTES + 1) {
    outputAbandoned = true
    throw new AgentMuxError('CLI pending output exceeds its byte budget; reconnect this reader. Existing Agents are preserved.', 'CONTROL_UNAVAILABLE')
  }
  stream.write(line)
}
let operationId: string | undefined
const outputClosed = new AbortController()
let outputFailed = false
let failureReported = false
let outputAbandoned = false
function partial(method: AgentMuxRpcMethod, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const body = result as Record<string, unknown>
  if (['space.focus', 'goal.focus', 'app.focus'].includes(method) && body.partial === true) return true
  if ((method === 'file.write' || method === 'file.create') && (body.result as { status?: string } | undefined)?.status !== 'written') return true
  if ((method === 'file.upload' || method === 'file.upload.inspect') && body.status !== 'uploaded') return true
  if (['file.build', 'file.build.inspect', 'file.build.cancel'].includes(method) && !['running', 'succeeded', 'cancelled'].includes(String(body.status))) return true
  if (method === 'file.format' && body.status !== 'formatted' && body.status !== 'unchanged') return true
  if (body.outcome === 'partial' || body.outcome === 'unknown' || body.outcome === 'refused') return true
  if (method === 'space.inspect' && Object.hasOwn(body, 'request')) {
    const request = body.request as { known?: boolean; report?: { outcome?: string } | null } | null
    return request?.known !== true || !request.report ||
      ['partial', 'unknown', 'refused'].includes(request.report.outcome ?? '')
  }
  return false
}
async function readStdin(maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk)
    bytes += part.length
    if (maxBytes !== undefined && bytes > maxBytes) throw new AgentMuxError('Task parameters exceed the 64 KiB input budget.', 'INVALID_CLI_ARGUMENT')
    chunks.push(part)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function follow(client: AgentMuxRpcClient, method: AgentMuxRpcStreamMethod, params: AgentMuxRpcStreamParams<AgentMuxRpcStreamMethod>): Promise<number> {
  const controller = new AbortController()
  let finish!: () => void
  let streamError: unknown
  let failureFrameDelivered = false
  let cancelled = false
  const ended = new Promise<void>(resolve => { finish = resolve })
  const interrupted = () => { cancelled = true; outputAbandoned = true; controller.abort(); finish() }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  outputClosed.signal.addEventListener('abort', interrupted, { once: true })
  let opened: { dispose(): Promise<void> } | undefined
  try {
    opened = await client.subscribe(method, params, {
      signal: controller.signal,
      onInitial: () => {},
      onFrame: frame => {
        // Opening failures use the CLI error envelope emitted by main. Successful
        // responses and subscription notifications keep their original RPC frame.
        if ('error' in frame && frame.error !== undefined) return
        write(frame, process.stdout, true)
      },
      onEvent: event => {
        if (event.type === 'error') { failureFrameDelivered = true; streamError = event.error; finish() }
        else if (event.type === 'end') finish()
      },
      onEnd: error => { if (error) streamError = error; finish() }
    })
    await ended
    if (cancelled) return 0
    if (streamError) {
      if (failureFrameDelivered) return 1
      throw streamError
    }
    return 0
  } catch (error) {
    if (!cancelled) throw error
    return 0
  } finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    outputClosed.signal.removeEventListener('abort', interrupted)
    await opened?.dispose()
  }
}
async function main(): Promise<number> {
  const { args } = agentMuxCliArguments(process.argv.slice(2))
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    const path = args.slice(1).join('.')
    const help = path ? agentMuxCommandHelp(path) : AGENTMUX_CLI_HELP
    if (!help) throw new AgentMuxError('Unknown command. Run amux --help.', 'INVALID_CLI_ARGUMENT')
    process.stdout.write(help + '\n'); return 0
  }
  if (args.length === 1 && args[0] === '--skill') { process.stdout.write(AGENTMUX_CLI_SKILL + '\n'); return 0 }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) { process.stdout.write(`amux ${packageManifest.version}\n`); return 0 }
  const match = agentMuxCliMatch(args)
  if (!match && (args.at(-1) === '--help' || args.at(-1) === '-h')) {
    const help = agentMuxCommandHelp(args.slice(0, -1).join('.'))
    if (!help) throw new AgentMuxError('Unknown command. Run amux --help.', 'INVALID_CLI_ARGUMENT')
    process.stdout.write(help + '\n'); return 0
  }
  if (match && agentMuxCliRequestsHelp(match.command, match.tail)) {
    process.stdout.write(agentMuxCommandHelp(match.command.method)! + '\n'); return 0
  }
  if (!match && AGENTMUX_CLI_COMMANDS.some(entry => entry.method.startsWith(args.join('.') + '.'))) {
    process.stdout.write(agentMuxCommandHelp(args.join('.'))! + '\n'); return 0
  }
  const invocation = await parseAgentMuxCliInvocation(process.argv.slice(2))
  operationId = typeof invocation.params.operationId === 'string' ? invocation.params.operationId : undefined
  const { method } = invocation.command
  if (method === 'mote.playbook.pmo') {
    write({ ok: true, operation: method, result: agentMuxPmoPlaybook() }); return 0
  }
  const endpoint = agentMuxRpcEndpoint(invocation.endpoint)
  if (method === 'system.endpoint' && !invocation.params.inspect) {
    if (invocation.params.stdio) {
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      try { await forwardAgentMuxRpcStdio({ endpoint, input: process.stdin, output: process.stdout, signal: controller.signal }) }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    } else {
      const { token: _secret, ...publicEndpoint } = endpoint as typeof endpoint & { token?: string }
      write({ ok: true, operation: method, result: { protocol: 'jsonrpc-2.0', framing: 'json-lines', endpoint: publicEndpoint, connection: 'not-attempted' } })
    }
    return 0
  }
  if (method === 'system.endpoint') invocation.params = {}
  if (!isAgentMuxRpcMethod(method)) throw new AgentMuxError('Command has no public service method.', 'INVALID_CLI_ARGUMENT')
  const sid = process.env.AGENTMUX_AGENT_SESSION_ID
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY
  if ((sid !== undefined || capability !== undefined) && (!sid?.length || !capability?.length)) {
    throw new AgentMuxError('Managed credentials require both exact Session claim and capability.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  }
  const client = await connectAgentMuxRpc({ endpoint, ...(sid && capability ? { credentials: { agentSessionId: sid, capability } } : {}) })
  try {
    if (method === 'space.commit') {
      try { invocation.params.graph = JSON.parse(await readStdin()) }
      catch { throw new AgentMuxError('A spatial graph JSON object is required on stdin.', 'INVALID_CLI_ARGUMENT') }
    }
    if (method === 'browser.run') invocation.params.code = await readStdin()
    if (method === 'file.write') invocation.params.content = await readStdin()
    if (method === 'browser.task.run') {
      const text = await readStdin(65_536)
      try { invocation.params.parameters = text.trim() ? JSON.parse(text) : {} }
      catch { throw new AgentMuxError('Task parameters must be a JSON object on stdin.', 'INVALID_CLI_ARGUMENT') }
    }
    if (method === 'browser.task.batch') {
      const text = await readStdin(65_536)
      let supplied: unknown
      try { supplied = text.trim() ? JSON.parse(text) : {} }
      catch { throw new AgentMuxError('Batch stdin must be a JSON object with parameters and items.', 'INVALID_CLI_ARGUMENT') }
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
          Object.keys(supplied).some(key => key !== 'parameters' && key !== 'items')) {
        throw new AgentMuxError('Batch stdin must contain only parameters and items.', 'INVALID_CLI_ARGUMENT')
      }
      invocation.params.parameters = (supplied as Record<string, unknown>).parameters
      invocation.params.items = (supplied as Record<string, unknown>).items
    }
    try {
      rpcEncode({ jsonrpc: '2.0', id: randomUUID(), method, params: { ...invocation.params,
        ...(sid && capability ? { caller: { agentSessionId: sid, capability } } : {}) } })
    } catch (error) {
      throw new AgentMuxError(error instanceof Error ? error.message : 'Command input is invalid.', 'INVALID_CLI_ARGUMENT')
    }
    if (isAgentMuxRpcStream(method, invocation.params)) {
      return await follow(client, method, invocation.params as AgentMuxRpcStreamParams<typeof method>)
    }
    const result = await client.call(method, invocation.params as AgentMuxRpcParams<AgentMuxRpcMethod>)
    const output = invocation.output === undefined ? undefined : await writeCliResourceDocument(invocation.output, result)
    write({ ok: true, operation: method, ...(output === undefined ? {} : { output }), ...(operationId === undefined ? {} : { operationId }), result })
    return partial(method, result) ? 1 : 0
  } finally { await client.dispose() }
}
function reportFailure(error: unknown): void {
  if (failureReported) return
  failureReported = true
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const { args } = (() => { try { return agentMuxCliArguments(process.argv.slice(2)) } catch { return { args: [] } } })()
  write({
    ok: false, operation: agentMuxCliMatch(args)?.command.method ?? null,
    ...(operationId === undefined ? {} : { operationId }),
    error: {
      code: typeof source?.code === 'string' ? source.code : 'AGENTMUX_FAILED',
      message: error instanceof Error ? error.message : typeof source?.message === 'string' ? source.message : String(error),
      ...(source?.detail === undefined ? {} : { detail: source.detail }),
      ...(source?.details === undefined ? {} : { details: source.details }),
      ...(source?.controlFailure === undefined ? {} : { controlFailure: source.controlFailure }),
      ...(source?.logId === undefined ? {} : { logId: source.logId }),
      ...(source?.candidates === undefined ? {} : { candidates: source.candidates })
    }
  }, process.stderr)
  process.exitCode = 1
}
process.stdout.on('error', () => {
  outputFailed = true
  outputClosed.abort()
  reportFailure(new AgentMuxError('CLI output consumer disconnected; reconnect using the original cursor.', 'CONTROL_UNAVAILABLE'))
})
function finishAbandonedOutput() {
  // process.stdout has special shutdown semantics: pending pipe writes can
  // keep it alive even after destroy(). Only an explicitly abandoned reader
  // skips them, after main has awaited subscription/client disposal and the
  // small stderr capacity receipt has flushed. Ordinary completion flushes.
  if (outputAbandoned) process.stderr.write('', () => process.exit(process.exitCode ?? 0))
}
void main().then(code => { if (!outputFailed) process.exitCode = code; finishAbandonedOutput() }, error => {
  reportFailure(error); finishAbandonedOutput()
})
