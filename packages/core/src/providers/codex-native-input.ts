import { JSONRPCErrorException } from 'json-rpc-2.0'
import { randomBytes, randomUUID } from 'node:crypto'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '../errors.js'
import { runProcess } from '../process-runner.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import type { AgentProvider } from '../agent-provider.js'
import { CODEX_NATIVE_TOKEN_ENV, type CodexManagedResume } from './codex-managed-run.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'

const PROTOCOL_ID = 'codex-app-server-v2-0.163'
const unavailable = () => new AgentMuxError('The exact native actor input service is unconfirmed. The original Agent and ordinary terminal input remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')

/** Shared configuration for already qualified create plans. */
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

/** Only explicit Core resume shapes: native policy is prepared before the TUI can carry its prompt. */
function nativeResumePlan(args: readonly string[], prompt?: string): { args: string[]; serverConfig: string[]; resume: CodexManagedResume } | null {
  if (args[0] !== 'resume' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(args[1] ?? '')) return null
  const resume: CodexManagedResume = { threadId: args[1]! }, serverConfig: string[] = [], removed = new Set<number>()
  let promptIndex = -1
  if (prompt?.trim()) {
    promptIndex = args[2] === prompt ? 2 : args[2] === '--dangerously-bypass-hook-trust' && args[3] === prompt ? 3 : -1
    if (promptIndex < 0) return null
  }
  for (let i = 2; i < args.length; i++) {
    if (i === promptIndex) continue
    const arg = args[i]!
    if (['-s', '--sandbox', '-a', '--ask-for-approval', '-m', '--model', '-C', '--cd'].includes(arg)) {
      const valueIndex = ++i, value = args[valueIndex]
      if (!value || valueIndex === promptIndex) return null
      if (arg === '-s' || arg === '--sandbox') {
        if (resume.sandbox !== undefined || !['read-only', 'workspace-write', 'danger-full-access'].includes(value)) return null
        resume.sandbox = value as NonNullable<CodexManagedResume['sandbox']>; removed.add(i - 1); removed.add(i)
      } else if (arg === '-a' || arg === '--ask-for-approval') {
        if (resume.approvalPolicy !== undefined || !['on-request', 'never'].includes(value)) return null
        resume.approvalPolicy = value as NonNullable<CodexManagedResume['approvalPolicy']>; removed.add(i - 1); removed.add(i)
      } else if (arg === '-m' || arg === '--model') {
        if (resume.model !== undefined) return null
        resume.model = value
      } else {
        if (resume.cwd !== undefined) return null
        resume.cwd = value
      }
    } else if (arg === '--enable' || arg === '--disable') {
      const value = args[++i]; if (!value || i === promptIndex) return null
      serverConfig.push(arg, value)
    } else if (arg.startsWith('--enable=') || arg.startsWith('--disable=')) serverConfig.push(arg)
    else if (!['--dangerously-bypass-hook-trust', '--no-alt-screen'].includes(arg)) return null
  }
  return { args: args.filter((_, i) => !removed.has(i)), serverConfig, resume }
}

export const prepareCodexManagedLaunch: NonNullable<AgentProvider['prepareManagedLaunch']> = async (plan, lifecycleOperationId, context) => {
  if (process.platform !== 'darwin' || context.kind === 'fork') return { plan }
  const prepared = context.kind === 'resume' ? nativeResumePlan(plan.args, context.prompt) : undefined
  if (context.kind === 'resume' && !prepared) return { plan }
  const args = prepared?.args ?? [...plan.args]
  const serverConfig = prepared?.serverConfig ?? nativeServerConfig(context.prompt && plan.args.at(-1) === context.prompt ? plan.args.slice(0, -1) : plan.args)
  if (!serverConfig) return { plan }
  // The version is the native CLI's stable version command, not a terminal screen or readiness guess.
  const version = await runProcess(plan.command, ['--version'], { env: plan.env, timeoutMs: 2_000, maxOutputBytes: 4096 }).catch(() => null)
  if (!version || version.exitCode !== 0 || version.stderr || version.stdout.trim() !== 'codex-cli 0.163.0') return { plan }
  const nativeActor = { protocolId: PROTOCOL_ID, actorId: randomUUID(), lifecycleOperationId, token: randomBytes(32).toString('hex'), launch: { command: plan.command, args } }
  return { nativeActor, plan: { command: process.execPath,
    args: [fileURLToPath(new URL('./codex-managed-run.js', import.meta.url)), JSON.stringify({ command: plan.command, args, serverConfig, ...(prepared ? { resume: prepared.resume } : {}) })],
    env: { ...plan.env, ELECTRON_RUN_AS_NODE: '1', [CODEX_NATIVE_TOKEN_ENV]: nativeActor.token } } }
}

export const prepareCodexNativeInput: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
  if (target.providerId !== 'codex' || context.nativeActor.protocolId !== PROTOCOL_ID) throw unavailable()
  const { processId, nativeActor, signal } = context
  const birth = await nativeProcessBirth(processId, signal)
  const listeners = await nativeProcessTcpListeners(processId, signal)
  if (listeners.length !== 1) throw unavailable()
  const listener = listeners[0]!, listenerBirth = await nativeProcessBirth(listener.processId, signal)
  const { request: call, dispose } = await connectCodexNativeActor(listener.endpoint, nativeActor.token, signal, 'agentmux_native_input')
  try {
    const value = await call('thread/read', { threadId: target.nativeSessionId, includeTurns: false })
    if (value?.thread?.id !== target.nativeSessionId || value.thread.canAcceptDirectInput !== true) throw unavailable()
    const plan = { kind: 'native-rpc' as const, protocolId: PROTOCOL_ID, sourceId: nativeInputSourceId(target),
      actorId: nativeActor.actorId, threadId: target.nativeSessionId,
      ...(target.expectedTurnId === undefined ? { operation: 'start-or-steer' as const } : { operation: 'steer' as const, expectedTurnId: target.expectedTurnId }) }
    return { plan, dispose,
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
  } catch (error) { dispose(); throw error }
}
