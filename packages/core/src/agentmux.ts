#!/usr/bin/env node
import { verifyGoalTicketProof } from '@agentmux/demand/goal-ticket-crypto'
import { meshPeerCode, decodeMeshPeerCode } from './mesh-peer-code.js'
import type { MeshNetworkSettings } from './mesh-network.js'
import { readSpaceSnapshot, observeSpace } from './space-authority-stream.js'
import { observeSpaceSessionStates } from './space-session-stream.js'
import type { SpaceAuthorityRef, SpaceWatch } from './space-authority.js'
import { analyseLocalV8Profile } from './v8-profile-analysis-cli.js'
import { mintObjectId } from './object-id.js'
import { writeRendererDiagnosticFile } from './renderer-scene-cli.js'
import { writeRuntimeV8Profile } from './runtime-v8-profile-cli.js'
import { writeRendererV8Profile } from './renderer-v8-profile-cli.js'
import { writeAppCaptureFile, appCaptureCliMetadata } from './app-capture-cli.js'
import { writeBrowserCaptureFile, writeBrowserHarFile, browserCaptureCliMetadata, resolveBrowserCaptureReport } from './browser-capture-cli.js'
import { writeRendererTrace } from './renderer-trace-cli.js'
import { writeCliResourceDocument } from './cli-resource-document.js'
import process from 'node:process'
import packageManifest from '../package.json' with { type: 'json' }
import {
  resolveAgentMuxRpcEndpoint,
  type AgentMuxRpcClient, type AgentMuxRpcMethod, type AgentMuxRpcParams,
  type AgentMuxRpcStreamMethod, type AgentMuxRpcStreamParams
} from './control-host.js'
import { agentMuxRpcEnvironmentCredentials } from './public-rpc-client.js'
import { connectAgentMuxCliSource, type AgentMuxCliSource } from './agentmux-cli-source.js'
import { forwardAgentMuxRpcStdio } from './agentmux-rpc-stdio.js'
import { isAgentMuxRpcMethod, isAgentMuxRpcStream } from './public-rpc.js'
import { AgentMuxError } from './errors.js'
import { assertAgentToolContextAvailable } from './agent-tool-context.js'
import { parseFileWriteParams } from './public-rpc-files.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from './public-rpc-wire.js'
import {
  AGENTMUX_CLI_COMMANDS, agentMuxCliArguments, agentMuxCliMatch,
  agentMuxCliRequestsHelp, parseAgentMuxCliInvocation
} from './agentmux-cli-commands.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from './agentmux-cli-help.js'
import { agentMuxPmoPlaybook } from './agentmux-pmo-playbook.js'
import { agentMuxModuleSkill } from './agentmux-cli-module-skills.js'
import { isConnectionCredentialMethod } from './connection-credential-codec.js'
import { prepareConnectionCredentialCli } from './connection-credential-cli.js'
import { isConnectionReceiverMethod } from './connection-receiver-codec.js'
import type { AgentMuxRpcCallOptions } from './public-rpc-client.js'
import { composeOutboundMessage } from './agent-outbound-message.js'
import type { GoalDelegationParamsMap, GoalDelegationResult, GoalReportResult } from './goal-delegation.js'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'

let selectedSource: AgentMuxCliSource | undefined
function write(value: unknown, stream: NodeJS.WriteStream = process.stdout, boundedReader = false): void {
  if (selectedSource && value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'jsonrpc')) {
    value = { ...value, source: selectedSource }
  }
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
function goalReviewGuidance(result: GoalDelegationResult, review: GoalDelegationParamsMap['goal.plan.review']['review']): string | undefined {
  if (!result.passRecorded) return
  const attempt = result.delegations.find(entry => entry.operationId === review.delegationOperationId && entry.planNodeId === review.nodeId)
  if (!attempt?.workerRunId || !attempt.report?.delivery) return
  const original = `Goal ${JSON.stringify(result.goalId)}, Ticket ${JSON.stringify(review.nodeId)}, attempt ${JSON.stringify(attempt.operationId)}`
  const target = `Session ${JSON.stringify(attempt.workerAgentSessionId)}, Run ${JSON.stringify(attempt.workerRunId)}, Host ${JSON.stringify(delegationWorkerHostId(attempt))}, Runtime ${JSON.stringify(attempt.report.delivery.authorRuntimeId)}`
  return composeOutboundMessage({ amux: [
    `Review passed for ${original}. The original executor is ${target}.`,
    'As the independent reviewer, read the original Goal for its current Supervisor and pass them this receipt. Keep your review role.',
    'As the current Supervisor, verify the exact attempt, report collection and remaining work. Assign the next ready Ticket when appropriate.',
    'When the handoff is confirmed and no work remains, ask the original executor to use amux goal closeout for this exact attempt and Run.',
    'Keep the original Run and operation if any check or receipt is unknown. Only an authorized person or device can read the exact Stop receipt with amux agent stop inspect.',
    'See amux goal --skill.'
  ].join('\n') })
}

function goalReportGuidance(result: GoalReportResult, input: GoalDelegationParamsMap['goal.report']): string | undefined {
  const attempt = 'kind' in result ? undefined : result.delegations.find(entry => entry.operationId === input.operationId)
  const source = 'kind' in result ? result.sourceMessageId : attempt?.sourceMessageId
  if (!source || !('kind' in result) && (!attempt?.planNodeId || attempt.report?.operationId !== input.report.operationId)) return
  const handoff = { goalId: input.goalId, operationId: input.operationId, sourceMessageId: source, replyMessageId: input.report.replyMessageId }
  return composeOutboundMessage({ amux: `Executor: read the original Goal and its current Supervisor. Give that Supervisor the original report references ${JSON.stringify(handoff)} to verify collection of this reply. Read back the handoff before checking whether you can stop your exact Run. See amux goal --skill.` })
}

function goalCollectionGuidance(result: GoalDelegationResult, input: GoalDelegationParamsMap['goal.collect']): string | undefined {
  const attempt = result.delegations.find(entry => entry.operationId === input.operationId)
  const collection = attempt?.collection
  if (!attempt?.planNodeId || !attempt.report?.delivery || collection?.operationId !== input.collection.operationId) return
  const handoff = { goalId: result.goalId, operationId: attempt.operationId, sourceMessageId: attempt.sourceMessageId,
    replyMessageId: collection.replyMessageId, collectionOperationId: collection.operationId, deliveryHash: attempt.report.delivery.hash,
    worker: { hostId: delegationWorkerHostId(attempt), runtimeId: attempt.report.delivery.authorRuntimeId, agentSessionId: attempt.workerAgentSessionId } }
  return composeOutboundMessage({ amux: `Supervisor: acknowledge handoff to the original executor if you still hold responsibility for this Goal. Refer to the saved collection ${JSON.stringify(handoff)}. See amux goal --skill.` })
}
function partial(method: AgentMuxRpcMethod, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const body = result as Record<string, unknown>
  if (['terminal.input', 'terminal.interrupt', 'terminal.stop'].includes(method) && ((!['applied', 'no-op'].includes(String(body.outcome))) || body.diskDurability !== 'confirmed')) return true
  if (method === 'space.close.apply' && ((body.operation as { outcome?: string; diskDurability?: string } | null)?.outcome !== 'applied' || (body.operation as { diskDurability?: string } | null)?.diskDurability !== 'confirmed')) return true
  if (method === 'space.close.prepare' && (body.operation as { diskDurability?: string } | null)?.diskDurability !== 'confirmed') return true
  if (method === 'space.close.ls' && body.availability !== 'complete') return true
  if ((method === 'agent.posture.set' || method === 'agent.configuration.set') && (body.outcome !== 'applied' || body.diskDurability !== 'confirmed')) return true
  if (method === 'node.locate' && body.status === 'unconfirmed') return true
  if (method === 'settings.mesh.configure' && body.diskDurability !== 'confirmed') return true
  if (method === 'settings.node.configure' && (body.operation as { status?: string } | undefined)?.status !== 'confirmed') return true
  if (method.startsWith('image.')) {
    const operation = body.recordedOperation as { state: string } | null
    if (body.state === 'unknown' || operation && operation.state !== 'completed') return true
  }
  if (method.startsWith('app.record.')) {
    const recording = body.recording as { state?: string } | null
    if (!recording || ['failed', 'partial', 'interrupted', 'stopping'].includes(String(recording.state))) return true
  }
  if (method.startsWith('native.')) {
    if (body.state === 'unknown' || body.error !== undefined) return true
    const native = body.result as Record<string, unknown> | undefined
    if (method === 'native.capture' && native?.state === 'failed') return true
    if (method === 'native.operation.inspect' && native?.state === 'unknown') return true
    if (method === 'native.action') {
      const verification = (native?.action as { verification?: { state?: string } } | undefined)?.verification
      if (!verification || verification.state === 'unverified' || verification.state === 'failed') return true
    }
  }
  if (['space.focus', 'goal.focus', 'app.focus'].includes(method) && body.partial === true) return true
  if ((method === 'file.share' || method === 'file.share.undo') && body.status !== 'committed') return true
  if (method === 'file.share.inspect') {
    if ((body.mode === 'request' || body.mode === 'undo')) { if ((body.result as { status?: string })?.status !== 'committed') return true }
    else if ((body.declaration as { status?: string })?.status !== 'confirmed' || ['create', 'source', 'destination'].some(key => {
      const phase = body[key] as { status?: string; event?: { status?: string } } | undefined
      return phase?.status !== 'read' || phase.event?.status !== 'committed'
    })) return true
  }
  if ((method === 'file.write' || method === 'file.create' || method === 'file.import' || method === 'file.restore' || method === 'file.undo') && (body.result as { status?: string } | undefined)?.status !== 'written') return true
  if (method === 'file.history' && (body.result as { status?: string } | undefined)?.status !== 'read') return true
  if ((method === 'file.upload' || method === 'file.upload.inspect') && body.status !== 'uploaded') return true
  if (['file.build', 'file.build.inspect', 'file.build.cancel'].includes(method) && !['running', 'succeeded', 'cancelled'].includes(String(body.status))) return true
  if (method === 'file.format' && body.status !== 'formatted' && body.status !== 'unchanged') return true
  if (method === 'system.metrics.host-profile.capture' && body.status !== 'completed') return true
  if (method === 'system.metrics.profile.capture' && (body.capture as { status: string }).status !== 'completed') return true
  if (method === 'system.metrics.trace.capture' && (body.capture as { status: string }).status !== 'completed') return true
  if (method === 'system.metrics.allocations.capture' && (body.capture as {status:string}).status !== 'completed') return true
  if (method === 'system.metrics.scene.capture') { const capture=body.capture as {scene:{status:string};persistence:{status:string}}; if(capture.scene.status !== 'completed' || capture.persistence.status !== 'confirmed') return true }
  if (method === 'system.metrics.scene.inspect' && (body.inspection as {status:string}).status !== 'available') return true
  if (method === 'system.metrics.animations.inspect' && (body.observation as { status: string }).status !== 'completed') return true
  if ((method === 'system.metrics.cache.inspect' || method === 'system.metrics.cache.reclaim') && (body.observation as { status: string }).status !== 'completed') return true
  if ((method === 'system.metrics.memory.inspect' || method === 'system.metrics.memory.workers.inspect') && (body.observation as { status: string }).status !== 'completed') return true
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
async function followSpace(client: Pick<AgentMuxRpcClient, 'subscribe'>, input: SpaceWatch, sessions = false): Promise<number> {
  const controller = new AbortController()
  let finish!: () => void, failure: Error | undefined, cancelled = false
  const ended = new Promise<void>(yes => { finish = yes })
  const cancel = () => { cancelled = true; controller.abort(); finish() }
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  outputClosed.signal.addEventListener('abort', cancel, { once: true })
  let reader: { dispose(): Promise<void> } | undefined
  try {
    const onError = (error: Error) => { failure = error; finish() }
    if (sessions) {
      const observation = await observeSpaceSessionStates(client, input, { signal: controller.signal, onError,
        onObservation: event => write({ ok: true, operation: 'space.sessions.watch', event }) })
      reader = observation
      write({ ok: true, operation: 'space.sessions.watch', event: { type: 'opening', data: observation.initial } })
    } else {
      const observation = await observeSpace(client, input, { signal: controller.signal, onError,
        onChange: (_snapshot, change) => write({ ok: true, operation: 'space.watch', event: { type: 'change', data: change } }) })
      reader = observation
      write({ ok: true, operation: 'space.watch', event: { type: 'snapshot', data: observation.initial, gap: observation.gap } })
    }
    await ended
    if (failure && !cancelled) throw failure
    return 0
  } catch (error) {
    if (cancelled) return 0
    throw error
  } finally {
    controller.abort(); await reader?.dispose()
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
    outputClosed.signal.removeEventListener('abort', cancel)
  }
}
async function follow(client: Pick<AgentMuxRpcClient, 'subscribe'>, method: AgentMuxRpcStreamMethod, params: AgentMuxRpcStreamParams<AgentMuxRpcStreamMethod>): Promise<number> {
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
    // CLI association metadata precedes this reader. Original RPC frames below
    // stay byte/protocol frames, without added business or routing fields.
    if (selectedSource) write({ ok: true, operation: method, event: { type: 'source' } }, process.stdout, true)
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
  if (args.length === 2 && args[1] === '--skill') {
    const skill = agentMuxModuleSkill(args[0]!)
    if (!skill) throw new AgentMuxError('Unknown module. Run amux --skill for the local module directory.', 'INVALID_CLI_ARGUMENT')
    process.stdout.write(skill + '\n'); return 0
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) { process.stdout.write(`amux ${packageManifest.version}\n`); return 0 }
  const match = agentMuxCliMatch(args)
  if (!match && (args.at(-1) === '--help' || args.at(-1) === '-h')) {
    const help = agentMuxCommandHelp(args.slice(0, -1).join('.'))
    if (!help) throw new AgentMuxError('Unknown command. Run amux --help.', 'INVALID_CLI_ARGUMENT')
    process.stdout.write(help + '\n'); return 0
  }
  if (match && await agentMuxCliRequestsHelp(match.command, match.tail)) {
    process.stdout.write(agentMuxCommandHelp(match.command.method)! + '\n'); return 0
  }
  if (!match && AGENTMUX_CLI_COMMANDS.some(entry => entry.method.startsWith(args.join('.') + '.'))) {
    process.stdout.write(agentMuxCommandHelp(args.join('.'))! + '\n'); return 0
  }
  const invocation = await parseAgentMuxCliInvocation(process.argv.slice(2))
  operationId = typeof invocation.params.operationId === 'string' ? invocation.params.operationId : undefined
  const { method } = invocation.command
  if (invocation.sourceHost !== undefined && (method === 'mesh.code.read' || method === 'mote.playbook.pmo' || method === 'goal.plan.verify' || method === 'system.metrics.profile.analyze' || method === 'system.endpoint' && !invocation.params.inspect)) {
    throw new AgentMuxError('--source-host selects a Source business service. This local/static command uses its original default or explicit endpoint.', 'INVALID_CLI_ARGUMENT')
  }
  if (method === 'mesh.code.read') {
    write({ ok: true, operation: method, result: decodeMeshPeerCode(String(invocation.params.code)) }); return 0
  }
  if (method === 'mote.playbook.pmo') {
    write({ ok: true, operation: method, result: agentMuxPmoPlaybook() }); return 0
  }
  if (method === 'goal.plan.verify') {
    const { proof, goalId, hash, fingerprint } = invocation.params
    const result = verifyGoalTicketProof(proof, { goalId: String(goalId), hash: String(hash), fingerprint: String(fingerprint) })
    write({ ok: true, operation: method, result }); return 0
  }
  if (method === 'system.metrics.profile.analyze') {
    const result = await analyseLocalV8Profile(String(invocation.params.input))
    write({ ok: result.status === 'analysed', operation: method, result }); return result.status === 'analysed' ? 0 : 2
  }
  assertAgentToolContextAvailable()
  const endpoint = await resolveAgentMuxRpcEndpoint(invocation.endpoint)
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
  const credentials = agentMuxRpcEnvironmentCredentials()
  const client = await connectAgentMuxCliSource({ endpoint, ...(invocation.sourceHost === undefined ? {} : { sourceHost: invocation.sourceHost }), ...(credentials ? { credentials } : {}) })
  selectedSource = client.source
  try {
    let callOptions: AgentMuxRpcCallOptions | undefined
    if (isConnectionCredentialMethod(method)) {
      const prepared = await prepareConnectionCredentialCli(client, method, invocation.params)
      invocation.params = prepared.params; callOptions = prepared.options
    }
    if (isConnectionReceiverMethod(method)) {
      const { ownership } = await client.call('connection.owner.inspect', {})
      if (ownership !== 'local') throw new AgentMuxError('Select the original connector hosting endpoint: connection owner inspect must confirm local ownership there, then runtime owner identity discovers its Runtime. An execution-only forwarding endpoint cannot substitute its own Runtime for receiver administration.', 'CONTROL_UNAVAILABLE')
      const { owner } = await client.call('runtime.owner.identity', {})
      if (owner.runtimeId !== invocation.hostingRuntimeId) throw new AgentMuxError('This endpoint is not the original receiver hosting Runtime. Retain its original endpoint, Runtime and operation; no action was rerouted.', 'RUNTIME_OWNER_MISMATCH')
      callOptions = { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } }
    }
    if (method === 'space.commit') {
      try { invocation.params.graph = JSON.parse(await readStdin()) }
      catch { throw new AgentMuxError('A spatial graph JSON object is required on stdin.', 'INVALID_CLI_ARGUMENT') }
    }
    if (method === 'browser.run' && invocation.params.code === undefined) invocation.params.code = await readStdin()
    if (method === 'file.write') invocation.params = parseFileWriteParams({ ...invocation.params, content: await readStdin() }) as unknown as Record<string, unknown>
    if (method === 'browser.task.run' && invocation.params.parameters === undefined) {
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
      rpcEncode({ jsonrpc: '2.0', id: mintObjectId(), method, params: { ...invocation.params,
        ...(credentials ? { caller: credentials } : {}) } })
    } catch (error) {
      throw new AgentMuxError(error instanceof Error ? error.message : 'Command input is invalid.', 'INVALID_CLI_ARGUMENT')
    }
    if (method === 'space.snapshot') {
      const result = await readSpaceSnapshot(client, invocation.params.reference as SpaceAuthorityRef)
      write({ ok: true, operation: method, result }); return 0
    }
    if (method === 'space.watch') return await followSpace(client, invocation.params as SpaceWatch)
    if (method === 'space.sessions.watch') return await followSpace(client, invocation.params as SpaceWatch, true)
    if (isAgentMuxRpcStream(method, invocation.params)) {
      return await follow(client, method, invocation.params as AgentMuxRpcStreamParams<typeof method>)
    }
    const result = await client.call(method, invocation.params as AgentMuxRpcParams<AgentMuxRpcMethod>, callOptions)
    if (match?.command.method === 'mesh.code') {
      const settings = result as MeshNetworkSettings
      write({ ok: true, operation: 'mesh.code', result: { owner: settings.owner, code: meshPeerCode(settings) } }); return 0
    }
    const harOutput = match?.command.method === 'browser.run' && invocation.output !== undefined
    let captureResult: unknown = result
    let output: { path: string } | undefined
    try {
      if (method === 'browser.run' && invocation.output !== undefined) {
        captureResult = await resolveBrowserCaptureReport(result, invocation.params.browserId as string, async code => {
          const readOperationId = mintObjectId()
          try {
            const continued = await client.call('browser.run', { browserId: invocation.params.browserId as string, code, operationId: readOperationId }, callOptions)
            return continued
          }
          catch (error) { throw new AgentMuxError(`${harOutput ? 'HAR' : 'Screenshot'} result read ${readOperationId} is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Keep the original capture; it was not repeated.`, 'BROWSER_CAPTURE_RESULT_READ_FAILED') }
        }, harOutput ? 'HAR' : 'screenshot')
      }
      output = invocation.output === undefined ? undefined : method === 'browser.run'
        ? await (harOutput ? writeBrowserHarFile : writeBrowserCaptureFile)(invocation.output, captureResult) : method === 'app.capture' || method === 'app.record.read'
        ? await writeAppCaptureFile(invocation.output, method, result) : method === 'system.metrics.host-profile.capture'
        ? await writeRuntimeV8Profile(invocation.output, result, invocation.params) : method === 'system.metrics.profile.capture'
        ? await writeRendererV8Profile(invocation.output, result) : method === 'system.metrics.allocations.capture' ? await writeRendererDiagnosticFile(invocation.output,result,'allocations') : method === 'system.metrics.scene.capture' ? await writeRendererDiagnosticFile(invocation.output,result,'scene-capture') : method === 'system.metrics.scene.inspect' ? await writeRendererDiagnosticFile(invocation.output,result,'scene-inspect') : method === 'system.metrics.trace.capture'
          ? await writeRendererTrace(invocation.output, result) : await writeCliResourceDocument(invocation.output, result)
    } catch (error) {
      if (!['browser.run','app.capture','app.record.read','system.metrics.host-profile.capture','system.metrics.profile.capture','system.metrics.trace.capture','system.metrics.allocations.capture','system.metrics.scene.capture','system.metrics.scene.inspect'].includes(method)) throw error
      const source = error instanceof Error ? error as Error & { code?: string; detail?: string } : null
      write({ ok: false, operation: method, ...(operationId === undefined ? {} : { operationId }), result: method === 'browser.run' ? browserCaptureCliMetadata(captureResult) : method === 'app.capture' || method === 'app.record.read' ? appCaptureCliMetadata(method, result) : result, outputError: { code: source?.code ?? (method === 'browser.run' ? 'BROWSER_CAPTURE_FILE_WRITE_FAILED' : method === 'system.metrics.trace.capture' ? 'TRACE_FILE_WRITE_FAILED' : 'PROFILE_FILE_WRITE_FAILED'),
        message: source?.message ?? String(error), ...(source?.detail === undefined ? {} : { detail: source.detail }) } })
      return 1
    }
    const guidance = method === 'goal.plan.review' ? goalReviewGuidance(result as GoalDelegationResult, (invocation.params as GoalDelegationParamsMap['goal.plan.review']).review)
      : method === 'goal.report' ? goalReportGuidance(result as GoalReportResult, invocation.params as GoalDelegationParamsMap['goal.report'])
        : method === 'goal.collect' ? goalCollectionGuidance(result as GoalDelegationResult, invocation.params as GoalDelegationParamsMap['goal.collect']) : undefined
    write({ ok: true, operation: method, ...(output === undefined ? {} : { output }), ...(operationId === undefined ? {} : { operationId }),
      ...(guidance ? { guidance } : {}),
      result: output && method === 'browser.run' ? browserCaptureCliMetadata(captureResult) : output && (method === 'app.capture' || method === 'app.record.read') ? appCaptureCliMetadata(method, result) : result })
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
      ...(source?.creationFailure === undefined ? {} : { creationFailure: source.creationFailure }),
      ...(source?.storageFailure === undefined ? {} : { storageFailure: source.storageFailure }),
      ...(source?.executionFailure === undefined ? {} : { executionFailure: source.executionFailure }),
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
