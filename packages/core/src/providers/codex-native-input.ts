import { mintObjectId } from '../object-id.js'
import { CODEX_NATIVE_TOKEN_ENV, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV } from './codex-managed-frontend.js'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '../errors.js'
import { runProcess } from '../process-runner.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import type { AgentProvider } from '../agent-provider.js'
import type { CodexManagedThreadConfiguration, CodexManagedRunPlan } from './codex-managed-run.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'
import { prepareCodexDurableQueueInput } from './codex-native-queue.js'

// Persisted contract identity, not the currently installed CLI version. Both
// qualified releases use this exact actor/input wire; old claims keep their ID.
const PROTOCOL_ID = 'codex-app-server-v2-0.163'
const BYPASS_PERMISSIONS = '--dangerously-bypass-approvals-and-sandbox'
const unavailable = () => new AgentMuxError('The exact native actor input service is unconfirmed. The original Agent and ordinary terminal input remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')

/** Shared configuration for already qualified create plans. */
function nativeServerConfig(args: readonly string[]): { serverConfig: string[]; frontendArgs: string[]; configuration: CodexManagedThreadConfiguration } | null {
  const result: string[] = [], frontendArgs: string[] = []
  const configuration: CodexManagedThreadConfiguration = {}
  let bypass = false, permission = false, custom = false
  const valueFlags = new Set(['-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd'])
  const shared = new Set(['-c', '--config', '--enable', '--disable'])
  const switches = new Set(['--dangerously-bypass-hook-trust', '--no-alt-screen'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === BYPASS_PERMISSIONS) {
      if (bypass) return null
      bypass = true
    } else if (shared.has(arg)) { const value = args[++i]; if (value === undefined || value.startsWith('-')) return null; result.push(arg, value); custom ||= arg === '-c' || arg === '--config' }
    else if (valueFlags.has(arg)) {
      const value = args[++i]; if (value === undefined || value.startsWith('-')) return null
      // This native version explicitly rejects --profile for app-server and
      // rejects legacy -c profile= too. Keep the complete original CLI instead.
      if (arg === '-p' || arg === '--profile') return null
      if (arg === '-s' || arg === '--sandbox') {
        if (configuration.sandbox !== undefined || !['read-only', 'workspace-write', 'danger-full-access'].includes(value)) return null
        configuration.sandbox = value as NonNullable<CodexManagedThreadConfiguration['sandbox']>
      } else if (arg === '-a' || arg === '--ask-for-approval') {
        if (configuration.approvalPolicy !== undefined || !['on-request', 'never'].includes(value)) return null
        configuration.approvalPolicy = value as NonNullable<CodexManagedThreadConfiguration['approvalPolicy']>
      } else if (arg === '-m' || arg === '--model') {
        if (configuration.model !== undefined) return null
        configuration.model = value
      } else {
        if (configuration.cwd !== undefined) return null
        configuration.cwd = value
      }
      permission ||= ['-s', '--sandbox', '-a', '--ask-for-approval'].includes(arg)
      custom ||= arg === '-p' || arg === '--profile'
    }
    else if (arg.startsWith('--config=') || arg.startsWith('--enable=') || arg.startsWith('--disable=')) { result.push(arg); custom ||= arg.startsWith('--config=') }
    else if (!switches.has(arg)) return null
    else frontendArgs.push(arg)
  }
  if (bypass && (permission || custom)) return null
  if (bypass) { configuration.sandbox = 'danger-full-access'; configuration.approvalPolicy = 'never' }
  return { serverConfig: result, frontendArgs, configuration }
}

/** Only explicit Core resume shapes: native policy is prepared before the TUI can carry its prompt. */
function nativeResumePlan(args: readonly string[], prompt?: string): Pick<CodexManagedRunPlan, 'serverConfig' | 'frontendArgs'> & { resume: CodexManagedThreadConfiguration & { threadId: string } } | null {
  // Match only the exact footer produced by this Provider, never an option value or wrapper delimiter.
  const actionIndex = args.length - (prompt?.trim() ? 4 : 2)
  if (actionIndex < 0 || args[actionIndex] !== 'resume' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(args[actionIndex + 1] ?? '') ||
      prompt?.trim() && (args[actionIndex + 2] !== '--' || args[actionIndex + 3] !== prompt)) return null
  const resume: CodexManagedThreadConfiguration & { threadId: string } = { threadId: args[actionIndex + 1]! }, serverConfig: string[] = [], frontendArgs: string[] = []
  for (let i = 0; i < actionIndex; i++) {
    const arg = args[i]!
    if (arg === BYPASS_PERMISSIONS) {
      if (resume.sandbox !== undefined || resume.approvalPolicy !== undefined) return null
      resume.sandbox = 'danger-full-access'; resume.approvalPolicy = 'never'
    } else if (['-s', '--sandbox', '-a', '--ask-for-approval', '-m', '--model', '-C', '--cd'].includes(arg)) {
      const valueIndex = ++i, value = args[valueIndex]
      if (!value || value.startsWith('-') || valueIndex >= actionIndex) return null
      if (arg === '-s' || arg === '--sandbox') {
        if (resume.sandbox !== undefined || !['read-only', 'workspace-write', 'danger-full-access'].includes(value)) return null
        resume.sandbox = value as NonNullable<CodexManagedThreadConfiguration['sandbox']>
      } else if (arg === '-a' || arg === '--ask-for-approval') {
        if (resume.approvalPolicy !== undefined || !['on-request', 'never'].includes(value)) return null
        resume.approvalPolicy = value as NonNullable<CodexManagedThreadConfiguration['approvalPolicy']>
      } else if (arg === '-m' || arg === '--model') {
        if (resume.model !== undefined) return null
        resume.model = value
      } else {
        if (resume.cwd !== undefined) return null
        resume.cwd = value
      }
    } else if (arg === '--enable' || arg === '--disable') {
      const value = args[++i]; if (!value || value.startsWith('-') || i >= actionIndex) return null
      serverConfig.push(arg, value)
    } else if (arg.startsWith('--enable=') || arg.startsWith('--disable=')) serverConfig.push(arg)
    else if (!['--dangerously-bypass-hook-trust', '--no-alt-screen'].includes(arg)) return null
    else frontendArgs.push(arg)
  }
  return { serverConfig, frontendArgs, resume }
}

export const prepareCodexManagedLaunch: NonNullable<AgentProvider['prepareManagedLaunch']> = async (plan, lifecycleOperationId, context) => {
  if (process.platform !== 'darwin' || context.kind === 'fork') return { plan }
  const prepared = context.kind === 'resume' ? nativeResumePlan(plan.args, context.prompt) : undefined
  if (context.kind === 'resume' && !prepared) return { plan }
  const creation = context.kind === 'create' ? nativeServerConfig(context.prompt && plan.args.at(-2) === '--' && plan.args.at(-1) === context.prompt ? plan.args.slice(0, -2) : plan.args) : undefined
  if (!prepared && !creation) return { plan }
  const { serverConfig, frontendArgs } = (prepared ?? creation)!
  // The version is the native CLI's stable version command, not a terminal screen or readiness guess.
  const version = await runProcess(plan.command, ['--version'], { env: plan.env, timeoutMs: 2_000, maxOutputBytes: 4096 }).catch(() => null)
  if (!version || version.exitCode !== 0 || version.stderr || !['codex-cli 0.163.0', 'codex-cli 0.165.0'].includes(version.stdout.trim())) return { plan }
  const nativeActor = { protocolId: PROTOCOL_ID, actorId: mintObjectId(), lifecycleOperationId, token: randomBytes(32).toString('hex'), frontendControl: true as const, initializationControl: true as const, launch: { command: plan.command, args: [...plan.args] } }
  const managed: CodexManagedRunPlan = { command: plan.command, serverConfig, frontendArgs,
    ...(prepared ? { resume: prepared.resume } : { create: creation!.configuration }) }
  return { nativeActor, promptDelivery: 'post-launch', plan: { command: process.execPath,
    args: [fileURLToPath(new URL('./codex-managed-run.js', import.meta.url)), JSON.stringify(managed)],
    env: { ...plan.env, ELECTRON_RUN_AS_NODE: '1', [CODEX_NATIVE_TOKEN_ENV]: nativeActor.token, [CODEX_ACTOR_ID_ENV]: nativeActor.actorId, [CODEX_ACTOR_LIFECYCLE_ENV]: lifecycleOperationId } } }
}

export const prepareCodexNativeInput: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
  if (!context.nativeActor) return await prepareCodexDurableQueueInput(context, target)
  if (target.providerId !== 'codex' || context.nativeActor.protocolId !== PROTOCOL_ID || target.idleOnly && target.expectedTurnId !== undefined) throw unavailable()
  const { processId, nativeActor, signal } = context
  const birth = await nativeProcessBirth(processId, signal)
  const listeners = await nativeProcessTcpListeners(processId, signal)
  if (listeners.length !== 1) throw unavailable()
  const listener = listeners[0]!, listenerBirth = await nativeProcessBirth(listener.processId, signal)
  const { request: call, dispose } = await connectCodexNativeActor(listener.endpoint, nativeActor.token, signal, 'agentmux_native_input')
  try {
    const assertPresent = async (): Promise<void> => {
      const value = await call('thread/read', { threadId: target.nativeSessionId, includeTurns: false })
      // read also serves unloaded history. Only the actor's live status proves membership.
      if (value?.thread?.id !== target.nativeSessionId || value.thread.canAcceptDirectInput !== true ||
          !['idle', 'active', 'systemError'].includes(value.thread.status?.type)) throw unavailable()
    }
    await assertPresent()
    const plan = { kind: 'native-rpc' as const, protocolId: PROTOCOL_ID, sourceId: nativeInputSourceId(target),
      actorId: nativeActor.actorId, threadId: target.nativeSessionId,
      ...(target.idleOnly ? { operation: 'queue-idle' as const } : target.expectedTurnId === undefined ? { operation: 'start-or-steer' as const } : { operation: 'steer' as const, expectedTurnId: target.expectedTurnId }) }
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted()
      if (await nativeProcessBirth(processId, signal) !== birth || await nativeProcessBirth(listener.processId, signal) !== listenerBirth ||
          !(await nativeProcessTcpListeners(processId, signal)).some(x => x.processId === listener.processId && x.endpoint === listener.endpoint)) throw unavailable()
      await assertPresent()
    }
    return { plan, assertCurrent, dispose,
      async send(prompt, frozen) {
        signal.throwIfAborted()
        if (frozen.protocolId !== plan.protocolId || frozen.actorId !== plan.actorId || frozen.sourceId !== plan.sourceId ||
            frozen.threadId !== plan.threadId || frozen.operation !== plan.operation || frozen.expectedTurnId !== target.expectedTurnId || !frozen.clientCorrelation) throw unavailable()
        await assertCurrent()
        try {
          if (frozen.operation === 'queue-idle') {
            // The original actor's durable queue atomically dispatches only while idle,
            // including when a manual turn wins after Core's final completion check.
            // Never start/reorder a native queue or re-add an unknown original claim.
            const input = [{ type: 'text', text: prompt, text_elements: [] }]
            const receipt = await call('thread/queue/add', { threadId: frozen.threadId, input, clientUserMessageId: frozen.clientCorrelation })
            const queued = receipt?.queuedSubmission
            if (typeof queued?.id !== 'string' || !queued.id || queued.clientUserMessageId !== frozen.clientCorrelation ||
                !isDeepStrictEqual(queued.input, input)) throw unavailable()
            return { outcome: 'admitted', queuedSubmissionId: queued.id }
          }
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
