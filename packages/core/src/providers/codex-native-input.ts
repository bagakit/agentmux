import WebSocket from 'ws'
import { JSONRPCClient, JSONRPCErrorException } from 'json-rpc-2.0'
import { randomBytes, randomUUID } from 'node:crypto'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '../errors.js'
import { runProcess } from '../process-runner.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import type { AgentProvider } from '../agent-provider.js'
import { CODEX_NATIVE_TOKEN_ENV } from './codex-managed-run.js'

const PROTOCOL_ID = 'codex-app-server-v2-0.163'
const unavailable = () => new AgentMuxError('The exact native actor input service is unconfirmed. The original Agent and ordinary terminal input remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')

/** Only the already qualified CLI shapes are converted. The original TUI retains every argument. */
function nativeServerConfig(args: readonly string[]): string[] | null {
  const result: string[] = []
  const valueFlags = new Set(['-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd'])
  const shared = new Set(['-c', '--config', '--enable', '--disable'])
  const switches = new Set(['--dangerously-bypass-hook-trust', '--no-alt-screen'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (shared.has(arg)) { const value = args[++i]; if (value === undefined) return null; result.push(arg, value) }
    else if (valueFlags.has(arg)) { if (args[++i] === undefined) return null }
    else if (arg.startsWith('--config=') || arg.startsWith('--enable=') || arg.startsWith('--disable=')) result.push(arg)
    else if (!switches.has(arg)) return null
  }
  return result
}

export const prepareCodexManagedLaunch: NonNullable<AgentProvider['prepareManagedLaunch']> = async (plan, lifecycleOperationId, context) => {
  if (process.platform !== 'darwin' || context.kind !== 'create') return { plan }
  const args = context.prompt && plan.args.at(-1) === context.prompt ? plan.args.slice(0, -1) : plan.args
  const serverConfig = nativeServerConfig(args)
  if (!serverConfig) return { plan }
  // The version is the native CLI's stable version command, not a terminal screen or readiness guess.
  const version = await runProcess(plan.command, ['--version'], { env: plan.env, timeoutMs: 2_000, maxOutputBytes: 4096 }).catch(() => null)
  if (!version || version.exitCode !== 0 || version.stderr || version.stdout.trim() !== 'codex-cli 0.163.0') return { plan }
  const nativeActor = { protocolId: PROTOCOL_ID, actorId: randomUUID(), lifecycleOperationId, token: randomBytes(32).toString('hex'), launch: { command: plan.command, args: [...plan.args] } }
  return { nativeActor, plan: { command: process.execPath,
    args: [fileURLToPath(new URL('./codex-managed-run.js', import.meta.url)), JSON.stringify({ command: plan.command, args: plan.args, serverConfig })],
    env: { ...plan.env, ELECTRON_RUN_AS_NODE: '1', [CODEX_NATIVE_TOKEN_ENV]: nativeActor.token } } }
}

export const prepareCodexNativeInput: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
  if (target.providerId !== 'codex' || context.nativeActor.protocolId !== PROTOCOL_ID) throw unavailable()
  const { processId, nativeActor, signal } = context
  const birth = await nativeProcessBirth(processId, signal)
  const listeners = await nativeProcessTcpListeners(processId, signal)
  if (listeners.length !== 1) throw unavailable()
  const listener = listeners[0]!, listenerBirth = await nativeProcessBirth(listener.processId, signal)
  const ws = new WebSocket(listener.endpoint, { headers: { Authorization: `Bearer ${nativeActor.token}` }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 2_000 })
  const client = new JSONRPCClient(request => new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(request), error => error ? reject(error) : resolve())
  }))
  const dispose = (): void => { client.rejectAllPendingRequests('Original native input connection closed.'); ws.terminate() }
  const abort = (): void => dispose()
  ws.on('error', () => client.rejectAllPendingRequests('Original native input transport unavailable.'))
  ws.on('close', () => client.rejectAllPendingRequests('Original native input transport closed.'))
  ws.on('message', bytes => {
    try {
      for (const line of bytes.toString().split('\n').filter(Boolean)) {
        const value = JSON.parse(line) as Record<string, unknown>
        // Server requests belong to the original TUI's request owner; this writer never answers them.
        if (!value.method && Object.hasOwn(value, 'id')) client.receive(value as never)
      }
    } catch { dispose() }
  })
  signal.addEventListener('abort', abort, { once: true })
  const call = async (method: string, params: Record<string, unknown>): Promise<any> => await client.timeout(10_000).request(method, params)
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    signal.throwIfAborted()
    await call('initialize', { clientInfo: { name: 'agentmux_native_input', version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {}, undefined)
    const value = await call('thread/read', { threadId: target.nativeSessionId, includeTurns: false })
    if (value?.thread?.id !== target.nativeSessionId || value.thread.canAcceptDirectInput !== true) throw unavailable()
    const plan = { kind: 'native-rpc' as const, protocolId: PROTOCOL_ID, sourceId: nativeInputSourceId(target),
      actorId: nativeActor.actorId, threadId: target.nativeSessionId,
      ...(target.expectedTurnId === undefined ? { operation: 'start-or-steer' as const } : { operation: 'steer' as const, expectedTurnId: target.expectedTurnId }) }
    return { plan, dispose: () => { signal.removeEventListener('abort', abort); dispose() },
      async send(prompt, frozen) {
        signal.throwIfAborted()
        if (frozen.protocolId !== plan.protocolId || frozen.actorId !== plan.actorId || frozen.sourceId !== plan.sourceId ||
            frozen.threadId !== plan.threadId || frozen.operation !== plan.operation || frozen.expectedTurnId !== target.expectedTurnId || !frozen.clientCorrelation) throw unavailable()
        if (await nativeProcessBirth(processId, signal) !== birth || await nativeProcessBirth(listener.processId, signal) !== listenerBirth ||
            !(await nativeProcessTcpListeners(processId, signal)).some(x => x.processId === listener.processId && x.endpoint === listener.endpoint)) throw unavailable()
        try {
          const receipt = await call(frozen.operation === 'start-or-steer' ? 'turn/start' : 'turn/steer', {
            threadId: frozen.threadId, ...(frozen.operation === 'start-or-steer' ? {} : { expectedTurnId: frozen.expectedTurnId }),
            input: [{ type: 'text', text: prompt }], clientUserMessageId: frozen.clientCorrelation })
          const turnId = frozen.operation === 'start-or-steer' ? receipt?.turn?.id : receipt?.turnId
          if (typeof turnId !== 'string' || !turnId || frozen.expectedTurnId !== undefined && turnId !== frozen.expectedTurnId) throw unavailable()
          return { outcome: 'admitted', turnId }
        } catch (error) {
          // Only the native protocol's explicit invalid-request/params response proves no input.
          if (error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) return { outcome: 'not-applied', errorCode: error.code }
          throw error
        }
      } }
  } catch (error) { signal.removeEventListener('abort', abort); dispose(); throw error }
}
