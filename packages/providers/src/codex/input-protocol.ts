import { isDeepStrictEqual } from 'node:util'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import type { connectCodexNativeActor } from './native-rpc.js'

export type CodexManagedThreadConfiguration = { sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy?: 'on-request' | 'never'; model?: string; cwd?: string }
export type CodexManagedResume = CodexManagedThreadConfiguration & { threadId: string }
export type CodexManagedRunPlan = { command: string; serverConfig: string[]; frontendArgs: string[] } &
  ({ create: CodexManagedThreadConfiguration; historyMode?: 'legacy'; resume?: never } |
    { resume: CodexManagedResume; create?: never; historyMode?: never })

// Persisted contract identity, not the currently installed CLI version.
// Qualified releases use this exact actor/input wire; old claims keep their ID.
export const CODEX_NATIVE_INPUT_PROTOCOL = 'codex-app-server-v2-0.163'
const BYPASS_PERMISSIONS = '--dangerously-bypass-approvals-and-sandbox'

export function createCodexManagedLaunchSyntax(isCodexManagedHookConfig: (value: string) => boolean) {
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
      } else if (shared.has(arg)) {
        const value = args[++i]; if (value === undefined || value.startsWith('-')) return null
        result.push(arg, value)
        custom ||= (arg === '-c' || arg === '--config') && !isCodexManagedHookConfig(value)
      }
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
      else if (arg.startsWith('--config=') || arg.startsWith('--enable=') || arg.startsWith('--disable=')) {
        result.push(arg); custom ||= arg.startsWith('--config=') && !isCodexManagedHookConfig(arg.slice('--config='.length))
      }
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
      } else if (arg === '-c' || arg === '--config') {
        const value = args[++i]
        if (!value || i >= actionIndex || !isCodexManagedHookConfig(value)) return null
        serverConfig.push(arg, value)
      } else if (arg.startsWith('--config=')) {
        if (!isCodexManagedHookConfig(arg.slice('--config='.length))) return null
        serverConfig.push(arg)
      } else if (arg === '--enable' || arg === '--disable') {
        const value = args[++i]; if (!value || value.startsWith('-') || i >= actionIndex) return null
        serverConfig.push(arg, value)
      } else if (arg.startsWith('--enable=') || arg.startsWith('--disable=')) serverConfig.push(arg)
      else if (!['--dangerously-bypass-hook-trust', '--no-alt-screen'].includes(arg)) return null
      else frontendArgs.push(arg)
    }
    return { serverConfig, frontendArgs, resume }
  }

  return { nativeServerConfig, nativeResumePlan }
}

type NativeInputPlan = { threadId: string; operation?: string; expectedTurnId?: string; clientCorrelation?: string }
type InputThread = { thread?: { id?: string; canAcceptDirectInput?: unknown; status?: { type?: string } } }

/** A saved thread can be readable while its live actor is unavailable. */
export function isCodexLoadedThread(value: InputThread | undefined, nativeSessionId: string): boolean {
  return value?.thread?.id === nativeSessionId &&
    ['idle', 'active', 'systemError'].includes(value.thread.status?.type ?? '')
}

/** Reading live settings does not grant turn-input eligibility. */
export function isCodexDirectInputThread(value: InputThread | undefined, nativeSessionId: string): boolean {
  return isCodexLoadedThread(value, nativeSessionId) && value?.thread?.canAcceptDirectInput === true
}

export async function sendCodexNativeInput(call: Awaited<ReturnType<typeof connectCodexNativeActor>>['request'],
  unavailable: () => Error, prompt: string, frozen: NativeInputPlan) {
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
      return { outcome: 'admitted' as const, queuedSubmissionId: queued.id }
    }
    const receipt = await call(frozen.operation === 'start-or-steer' ? 'turn/start' : 'turn/steer', {
      threadId: frozen.threadId, ...(frozen.operation === 'start-or-steer' ? {} : { expectedTurnId: frozen.expectedTurnId }),
      input: [{ type: 'text', text: prompt }], clientUserMessageId: frozen.clientCorrelation })
    const turnId = frozen.operation === 'start-or-steer' ? receipt?.turn?.id : receipt?.turnId
    if (typeof turnId !== 'string' || !turnId || frozen.expectedTurnId !== undefined && turnId !== frozen.expectedTurnId) throw unavailable()
    return { outcome: 'admitted' as const, turnId }
  } catch (error) {
    // Only the native protocol's explicit invalid-request/params response proves no input.
    if (error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) return { outcome: 'not-applied' as const, errorCode: error.code }
    throw error
  }
}
