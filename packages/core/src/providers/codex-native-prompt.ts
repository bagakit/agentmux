import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import type { JSONRPCResponse } from 'json-rpc-2.0'
import { readNativeProcessVersion, type NativeProcessFile } from '../agent-native-process.js'
import { openNativeSocketChannel } from '../agent-native-socket.js'
import type { AgentProvider, AgentProviderNativePromptInput } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { codexNativeSourceId } from './codex-prompt-execution-evidence.js'
import { codexMainNativeRecord } from './codex-native-record-role.js'
import { locateAppServerNativeSession } from './app-server-native-session.js'

function waiting(phase: string, reason: string): AgentMuxError {
  return new AgentMuxError('The original native input channel is unconfirmed. This read-only preparation observation has ended before dispatch; the original terminal remains available. Keep the original caller input.',
    'AGENT_NATIVE_INPUT_WAITING', JSON.stringify({ phase, reason }))
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function result(response: JSONRPCResponse, phase: string): Record<string, unknown> {
  const value = object(response.result)
  if (response.error !== undefined || !value) throw waiting(phase, 'native-read-unconfirmed')
  return value
}

/** The already OS-bound actor may hold several descriptors for its one record. */
export function hasCodexNativeWriter(files: readonly NativeProcessFile[], peerPid: number, path: string, stat: { dev: bigint; ino: bigint }): boolean {
  return files.some(file => file.processId === peerPid && file.path === path && file.device === stat.dev && file.inode === stat.ino && (file.access === 'w' || file.access === 'u'))
}

/** Only after the original actor's current mapped 0.162.1 image qualified this contract. */
export function codexNativePromptReceipt(response: JSONRPCResponse): Awaited<ReturnType<AgentProviderNativePromptInput['dispatch']>> {
  if (response.error) {
    const code = response.error.code
    return code === -32600 || code === -32602 ? { outcome: 'not-applied', errorCode: code } : { outcome: 'unknown', errorCode: code }
  }
  const admitted = object(object(response.result)?.turn)
  return typeof admitted?.id === 'string' && admitted.id.length > 0 && admitted.status === 'inProgress'
    ? { outcome: 'admitted', turnId: admitted.id } : { outcome: 'unknown' }
}

/** rust-v0.162.1 turn/start: original loaded actor atomically starts or steers manual input. */
export async function prepareCodexNativePromptInput(context: Parameters<NonNullable<AgentProvider['prepareNativePromptInput']>>[0]): Promise<AgentProviderNativePromptInput> {
  const handle = context.nativeHandle, signal = context.signal
  context.onPreparationPhase?.('native-target')
  if (!context.processId || handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath) {
    throw waiting('native-target', 'original-native-handle-unconfirmed')
  }
  // The actual connected peer is selected by OS facts. CLI args, daemon rendezvous
  // files, addresses, versions and successful connects cannot establish that owner.
  context.onPreparationPhase?.('native-peer')
  const remote = context.args.flatMap((arg, index) => arg === '--remote' ? [context.args[index + 1]] : arg.startsWith('--remote=') ? [arg.slice(9)] : [])
  if (remote.length > 1 || remote.length && (typeof remote[0] !== 'string' || !remote[0].startsWith('unix://'))) throw waiting('native-peer', 'native-endpoint-unconfirmed')
  const advertised = remote[0]?.slice(7) ?? ''
  if (advertised && !advertised.startsWith('/')) throw waiting('native-peer', 'native-endpoint-unconfirmed')
  // Native advertises a rendezvous alias for its protected physical socket. Resolving
  // that alias only selects a candidate; original FD/peer/source checks grant authority.
  const endpoint = advertised ? await realpath(advertised) : ''
  const channel = await openNativeSocketChannel(context.processId, endpoint, signal).catch(error => {
    const reported = waiting('native-peer', 'original-channel-unconfirmed')
    Object.defineProperty(reported, 'cause', { value: error });
    throw new AgentMuxError(reported.message, reported.code, JSON.stringify({ phase: 'native-peer', reason: 'original-channel-unconfirmed',
      observation: error instanceof AgentMuxError ? { code: error.code, detail: error.detail } : { name: error instanceof Error ? error.name : 'unknown' } }))
  })
  try {
    context.onPreparationPhase?.('native-protocol')
    const version = await readNativeProcessVersion(channel.binding.peerPid, signal)
    // This explicit CLI version response qualifies the version-specific error contract;
    // it does not establish the original actor, which the OS binding establishes.
    if (version !== 'codex-cli 0.162.1\n') throw waiting('native-protocol', 'native-error-contract-unsupported')
    context.onPreparationPhase?.('native-initialize')
    result(await channel.request('initialize', { clientInfo: { name: 'agentmux', version: '0.1.0' }, capabilities: { experimentalApi: true } }, undefined, signal), 'native-initialize')
    channel.notify('initialized')
    const verifySource = async (currentSignal: AbortSignal): Promise<string> => {
      await channel.assertCurrent(currentSignal)
      // The saved thread may remain active/writable after this same actor opens
      // another main thread. Reuse discovery's unique-role contract on this exact
      // OS-bound peer; neither active status nor the most recent record selects it.
      const current = await locateAppServerNativeSession({ processId: channel.binding.peerPid, signal: currentSignal }, codexMainNativeRecord, 'process')
        .catch(error => {
          const reported = waiting('native-source', error instanceof AgentMuxError && error.code === 'AGENT_NATIVE_IDENTITY_AMBIGUOUS'
            ? 'original-main-record-ambiguous' : 'original-main-record-unconfirmed')
          Object.defineProperty(reported, 'cause', { value: error }); throw reported
        })
      if (!current || current.id !== handle.sessionId || current.file.path !== handle.transcriptPath) throw waiting('native-source', 'original-main-record-changed')
      const file = await open(handle.transcriptPath!, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat({ bigint: true })
        if (!stat.isFile()) throw waiting('native-source', 'native-source-not-file')
        if (!hasCodexNativeWriter([current.file], channel.binding.peerPid, handle.transcriptPath!, stat)) throw waiting('native-source', 'original-peer-writer-unconfirmed')
        await channel.assertCurrent(currentSignal)
        return codexNativeSourceId(handle.sessionId, stat)
      } finally { await file.close() }
    }
    context.onPreparationPhase?.('native-source')
    const sourceId = await verifySource(signal)
    context.onPreparationPhase?.('native-thread')
    const thread = object(result(await channel.request('thread/read', { threadId: handle.sessionId, includeTurns: false }, undefined, signal), 'native-thread').thread)
    const status = object(thread?.status)
    if (thread?.id !== handle.sessionId || thread.path !== handle.transcriptPath ||
        status?.type !== 'idle' && status?.type !== 'active') throw waiting('native-thread', 'original-loaded-thread-unconfirmed')
    // Idle and busy are both permitted by this manual intent. Native makes the
    // selection atomically; this observation never grants an automatic idle fence.
    let dispatched = false
    return {
      plan: { kind: 'native-rpc', protocolId: 'codex-turn-start-v0.162.1', operation: 'start-or-steer', sourceId, actorId: channel.sourceId, threadId: handle.sessionId },
      assertCurrent: async fresh => { if (await verifySource(fresh) !== sourceId) throw waiting('native-source', 'native-source-changed') },
      dispatch: async (prompt, operationId, waitSignal) => {
        if (dispatched) throw new AgentMuxError('The original Native request has already been dispatched.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
        dispatched = true
        const response = await channel.request('turn/start', { threadId: handle.sessionId, clientUserMessageId: operationId,
          input: [{ type: 'text', text: prompt, text_elements: [] }] }, operationId,
          waitSignal ? AbortSignal.any([waitSignal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000))
        // Internal errors and lost replies can occur after queueing. No display
        // message or clientUserMessageId is a negative/deduplication receipt.
        return codexNativePromptReceipt(response)
      },
      close: channel.close
    }
  } catch (error) { await channel.close(); throw error }
}
