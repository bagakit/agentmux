import { mintObjectId } from '../object-id.js'
import { CODEX_NATIVE_TOKEN_ENV, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV } from './codex-managed-frontend.js'
import { randomBytes } from 'node:crypto'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '../errors.js'
import { runProcess } from '../process-runner.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import type { AgentProvider } from '../agent-provider.js'
import { CODEX_NATIVE_INPUT_PROTOCOL as PROTOCOL_ID, createCodexManagedLaunchSyntax, isCodexDirectInputThread,
  sendCodexNativeInput, type CodexManagedRunPlan } from '@agentmux/providers/codex/input-protocol'
import { connectCodexNativeActor } from '@agentmux/providers/codex/native-rpc'
import { prepareCodexDurableQueueInput } from './codex-native-queue.js'
import { isCodexManagedHookConfig } from './codex-hook-services.js'

const unavailable = () => new AgentMuxError('The exact native actor input service is unconfirmed. The original Agent and ordinary terminal input remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')

const { nativeServerConfig, nativeResumePlan } = createCodexManagedLaunchSyntax(isCodexManagedHookConfig)

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
  // This release can rejoin an existing native thread, but an empty managed
  // thread cannot attach its TUI. Keep the original ordinary creation plan.
  if (version.stdout.trim() === 'codex-cli 0.165.0' && context.kind === 'create') return { plan }
  const nativeActor = { protocolId: PROTOCOL_ID, actorId: mintObjectId(), lifecycleOperationId, token: randomBytes(32).toString('hex'), frontendControl: true as const, initializationControl: true as const, launch: { command: plan.command, args: [...plan.args] } }
  const managed: CodexManagedRunPlan = { command: plan.command, serverConfig, frontendArgs,
    ...(prepared ? { resume: prepared.resume } : { create: creation!.configuration }) }
  return { nativeActor, promptDelivery: 'post-launch', plan: { ...plan, command: process.execPath,
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
      if (!isCodexDirectInputThread(value, target.nativeSessionId)) throw unavailable()
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
        return await sendCodexNativeInput(call, unavailable, prompt, frozen)
      } }
  } catch (error) { dispose(); throw error }
}
