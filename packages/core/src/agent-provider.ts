import { AgentMuxError } from './errors.js'
import type { ExecutionHost } from './execution-host.js'
import {
  cloneLaunchOptions,
  describeLaunchOptions,
  resolveLaunchOptionArgv,
  validateLaunchOptionDeclarations,
  type LaunchOptionDeclaration,
  type LaunchOptionSelection
} from './agent-launch-option.js'
import {
  createPostureControl,
  normalizeTerminalInteraction,
  type AgentPostureProtocol,
  type AgentTerminalInteractionProtocol,
  type PostureControlDeclaration
} from './agent-interaction.js'
import { normalizeNativeHook, type AgentNativeHookSpecification } from './hook-normalizer.js'
import type { AgentManagedHookPlan } from './managed-hook-installer.js'
import { createBuiltInAgentProviders, MANAGED_HOOK_PLAN_RESOLVERS } from './providers/index.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentProviderId,
  AgentLaunchPlan,
  AgentMuxInteractionInputPlan,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentPostureInputPlan,
  AgentPromptInputPlan,
  AgentProviderLaunchContext,
  AgentProviderResumeContext,
  AgentTerminalHandshake,
  AgentTerminalPromptRenderMatcher,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

export type AgentExecutableProbe = {
  hasExecutable(executable: string): Promise<boolean>
}

export type AgentProvider = {
  readonly id: AgentProviderId
  readonly label: string
  readonly executable: string
  readonly catalog: AgentCatalogEntry
  readonly terminalHandshake?: AgentTerminalHandshake
  readonly terminalPromptRender?: AgentTerminalPromptRenderMatcher
  probeCapabilities(probe: AgentExecutableProbe, commandOverride?: string): Promise<AgentCapabilitySnapshot>
  buildLaunch(context: AgentProviderLaunchContext): AgentLaunchPlan
  buildResumeLaunch(context: AgentProviderResumeContext): AgentLaunchPlan
  resolveLaunchArgv(selections: LaunchOptionSelection): string[]
  planPromptInput(prompt: string): AgentPromptInputPlan
  planInteractionResponse(
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse
  ): AgentMuxInteractionInputPlan
  planPostureSet(modeId: string): AgentPostureInputPlan
  normalizeHook(envelope: NativeHookEnvelope): NormalizedHookEvent
}

export type AgentCatalogSeed = Omit<AgentCatalogEntry, 'readySignal' | 'launchOptions'>

export type AgentProviderDefinition = {
  catalog: Omit<AgentCatalogEntry, 'launchOptions'>
  buildArgs(prompt: string, args: readonly string[]): string[]
  hook: AgentNativeHookSpecification
  launchOptions?: readonly LaunchOptionDeclaration[]
  terminalHandshake?: AgentTerminalHandshake
  terminalPromptRender?: AgentTerminalPromptRenderMatcher
  buildResumeArgs?: (
    sessionId: string,
    transcriptPath: string | undefined,
    prompt: string | undefined,
    args: readonly string[]
  ) => string[]
  planPromptInput?: (prompt: string) => AgentPromptInputPlan
  interaction?: AgentTerminalInteractionProtocol
  posture?: PostureControlDeclaration
}

/**
 * 恢复被拒时附在错误上的细节：一小组机器可读的生命周期事实。
 *
 * 为什么必须有：`INVALID_NATIVE_SESSION_HANDLE` 这一个码此前同时承载**两种完全不同的失败**——
 * 「这个 handle 属于别的 Provider」与「这个 Provider 要 transcript 路径但 hook 没报」。两者该做的事
 * 相反（前者刷新会话，后者等 hook 或换 Provider），可界面只能笼统说一句恢复不了。细节把「卡在哪、
 * 涉及哪个 Provider/handle、下一步该做什么」分开说清。
 *
 * 刻意只放 Provider id、locator 种类、缺了哪个字段这类事实：**绝不放 sessionId、transcript 路径
 * 或 prompt 正文**——它们是用户输入或可定位到用户工作内容的串，而这个 detail 会跨客户端边界。
 */
function resumeRefusalDetail(
  fields: Readonly<Record<string, string | number | boolean | undefined>>
): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
}

function executable(commandOverride: string | undefined, fallback: string): string {
  const command = commandOverride?.trim() || fallback
  if (!command) throw new AgentMuxError('Agent command cannot be empty.', 'INVALID_AGENT_COMMAND')
  return command
}

/**
 * 把一份已组装好的启动文本按 `promptDelivery` 分成「随启动送」与「起来之后送」两半。
 *
 * 为什么必须是一个共用的纯函数，而不是在两条生命周期路径上各写一遍条件：
 *   1. `buildLaunch`/`buildResumeLaunch` 会**拒绝**给 `post-launch-only` 的 Provider 带任何启动
 *      prompt，所以调用方必须先分流。两处各判一次，就迟早有一处判反——那正是「两条路对同一个
 *      『送得到吗』给不同答案」的经典形状。
 *   2. 分流必须**同时**给出 deferred 那一半。只做「不交给 buildLaunch」而不返回要补送的文本，
 *      等于把静默丢失从 argv 挪到了调用点：用户的原话仍旧只落进时间轴、永不进入进程。
 *
 * 分完之后两半必定恰有一半非空（composed 为空时两半皆空），调用方对 deferred 只有一个正确
 * 处置：起来之后当一条普通 turn 键入。
 */
export function splitLaunchPromptByDelivery(
  catalog: AgentCatalogEntry,
  composed: string
): { atLaunch: string; deferred: string } {
  return catalog.promptDelivery === 'post-launch-only'
    ? { atLaunch: '', deferred: composed }
    : { atLaunch: composed, deferred: '' }
}

export function defineAgentProvider(definition: AgentProviderDefinition): AgentProvider {
  const { catalog: catalogSeed } = definition
  if (definition.terminalHandshake && (!definition.terminalHandshake.query || !definition.terminalHandshake.response)) {
    throw new AgentMuxError('Agent terminal handshake bytes cannot be empty.', 'INVALID_AGENT_PROVIDER')
  }
  if (
    definition.terminalPromptRender &&
    (!definition.terminalPromptRender.frameStart || !definition.terminalPromptRender.activeComposer || !definition.terminalPromptRender.frameEnd)
  ) {
    throw new AgentMuxError('Agent terminal prompt render matcher cannot be empty.', 'INVALID_AGENT_PROVIDER')
  }
  const launchOptionDeclarations = definition.launchOptions ?? []
  validateLaunchOptionDeclarations(catalogSeed.id, launchOptionDeclarations)
  const posture: AgentPostureProtocol | undefined = definition.posture
    ? createPostureControl(definition.posture)
    : undefined
  const catalog: AgentCatalogEntry = {
    ...catalogSeed,
    launchOptions: describeLaunchOptions(launchOptionDeclarations),
    ...(posture ? { postureControl: posture.control } : {})
  }
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    catalog,
    ...(definition.terminalHandshake ? { terminalHandshake: { ...definition.terminalHandshake } } : {}),
    ...(definition.terminalPromptRender ? { terminalPromptRender: { ...definition.terminalPromptRender } } : {}),
    async probeCapabilities(probe, commandOverride) {
      const command = executable(commandOverride, catalog.executable)
      return {
        providerId: catalog.id,
        executable: command,
        installed: await probe.hasExecutable(command),
        capabilities: { ...catalog.capabilities }
      }
    },
    buildLaunch(context) {
      const prompt = context.prompt.trim()
      // 「送不到」必须在此刻响亮地失败，绝不能让 buildArgs 静静把 prompt 丢掉：那会让用户的原话
      // 只落进 timeline 而永不进入进程，且界面上一切正常——正是最难发现的一类数据丢失。
      // 这条不是「以后再修」的占位：这个 CLI 的交互 UI 没有带 prompt 启动的入口（见对应 Provider
      // 模块的出处），所以启动期送达在它这里根本不存在，而不是还没接。
      if (prompt && catalog.promptDelivery === 'post-launch-only') {
        throw new AgentMuxError(
          `${catalog.label} cannot receive a prompt at launch; start it first, then submit the prompt.`,
          'AGENT_LAUNCH_PROMPT_UNSUPPORTED',
          // prompt 是用户内容，只报长度不报正文。
          `providerId=${catalog.id} promptDelivery=${catalog.promptDelivery} promptLength=${prompt.length}`
        )
      }
      return {
        command: executable(context.commandOverride, catalog.executable),
        args: definition.buildArgs(prompt, context.args),
        env: { ...context.env }
      }
    },
    buildResumeLaunch(context) {
      if (!definition.buildResumeArgs || catalog.resumeStrategy.kind === 'none') {
        throw new AgentMuxError(
          `${catalog.label} does not support provider-native resume.`,
          'AGENT_RESUME_UNSUPPORTED',
          resumeRefusalDetail({
            providerId: catalog.id,
            resumeStrategy: catalog.resumeStrategy.kind,
            // 声明与实现分开报：只缺实现是 Provider 模块的 bug，声明为 none 则是这个 CLI 本来就不支持。
            declaresResume: catalog.capabilities.providerResume,
            hasResumeBuilder: Boolean(definition.buildResumeArgs),
            reason: catalog.resumeStrategy.kind === 'none' ? 'provider-has-no-native-resume' : 'resume-builder-missing'
          })
        )
      }
      const handle = context.nativeHandle
      if (handle.kind !== 'provider' || handle.providerId !== catalog.id) {
        throw new AgentMuxError(
          'Native session handle does not belong to this provider.',
          'INVALID_NATIVE_SESSION_HANDLE',
          resumeRefusalDetail({
            expectedProviderId: catalog.id,
            handleKind: handle.kind,
            // handle 上的 providerId 是 Provider 标识而非用户内容，可以安全带出去；sessionId 不带。
            handleProviderId: handle.kind === 'provider' ? handle.providerId : undefined,
            reason: handle.kind === 'provider' ? 'handle-provider-mismatch' : 'handle-not-provider-native'
          })
        )
      }
      const resumePrompt = context.prompt?.trim() || undefined
      // 恢复路径同理：`post-launch-only` 的 CLI 在续跑时也没有随启动带 prompt 的入口。
      // 这里必须与 buildLaunch 判得一样——两条路对同一个「送得到吗」的问题给不同答案，
      // 就是下一个只在其中一条路上出现的静默丢失。
      if (resumePrompt && catalog.promptDelivery === 'post-launch-only') {
        throw new AgentMuxError(
          `${catalog.label} cannot receive a prompt at launch; resume it first, then submit the prompt.`,
          'AGENT_LAUNCH_PROMPT_UNSUPPORTED',
          `providerId=${catalog.id} promptDelivery=${catalog.promptDelivery} promptLength=${resumePrompt.length}`
        )
      }
      return {
        command: executable(context.commandOverride, catalog.executable),
        args: definition.buildResumeArgs(
          handle.sessionId,
          handle.transcriptPath,
          resumePrompt,
          context.args
        ),
        env: { ...context.env }
      }
    },
    resolveLaunchArgv(selections) {
      return resolveLaunchOptionArgv(catalog.id, launchOptionDeclarations, selections)
    },
    planPromptInput(prompt) {
      return definition.planPromptInput?.(prompt) ?? { kind: 'single-phase', data: `${prompt}\r` }
    },
    planInteractionResponse(request, response) {
      if (!definition.interaction) {
        throw new AgentMuxError(`${catalog.label} does not support semantic terminal interactions.`, 'AGENT_INTERACTION_UNSUPPORTED')
      }
      return definition.interaction.planResponse(request, response)
    },
    planPostureSet(modeId) {
      if (!posture) {
        throw new AgentMuxError(`${catalog.label} does not expose a live posture control.`, 'AGENT_POSTURE_UNSUPPORTED')
      }
      return posture.planSet(modeId)
    },
    normalizeHook(envelope) {
      if (envelope.providerId !== catalog.id) {
        throw new AgentMuxError('Hook event does not belong to this provider.', 'HOOK_PROVIDER_MISMATCH')
      }
      const normalized = normalizeNativeHook(definition.hook, envelope)
      const interaction = definition.interaction
        ? normalizeTerminalInteraction(envelope, normalized.status.observedAt, definition.interaction)
        : undefined
      return interaction ? { ...normalized, interaction } : normalized
    }
  }
}

export function resolveManagedHookPlan(
  providerId: AgentProviderId,
  workspacePath: string,
  env?: Readonly<Record<string, string>>
): AgentManagedHookPlan | null {
  return MANAGED_HOOK_PLAN_RESOLVERS[providerId]?.(workspacePath, env) ?? null
}

export const BUILT_IN_AGENT_PROVIDERS: readonly AgentProvider[] = createBuiltInAgentProviders(defineAgentProvider)

export function executionHostProbe(host: ExecutionHost): AgentExecutableProbe {
  return {
    async hasExecutable(command) {
      const result = await host.run(
        'sh',
        ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'agentmux-detect', command],
        { timeoutMs: 8_000 }
      )
      return result.exitCode === 0
    }
  }
}

export class AgentProviderRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>()

  constructor(providers: readonly AgentProvider[] = BUILT_IN_AGENT_PROVIDERS) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new AgentMuxError(`Agent provider already registered: ${provider.id}`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(provider.id, provider)
  }

  replace(provider: AgentProvider): void { this.providers.set(provider.id, provider) }

  get(id: AgentProviderId): AgentProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new AgentMuxError(`Unknown agent provider: ${id}`, 'UNKNOWN_PROVIDER')
    return provider
  }

  list(): AgentProvider[] { return [...this.providers.values()] }

  catalog(): AgentCatalogEntry[] {
    return this.list().map((provider) => ({
      ...provider.catalog,
      readySignal: { ...provider.catalog.readySignal },
      hookStrategy: { ...provider.catalog.hookStrategy },
      resumeStrategy: { ...provider.catalog.resumeStrategy },
      acpStrategy: { ...provider.catalog.acpStrategy },
      capabilities: { ...provider.catalog.capabilities },
      launchOptions: cloneLaunchOptions(provider.catalog.launchOptions),
      ...(provider.catalog.postureControl
        ? {
            postureControl: {
              id: provider.catalog.postureControl.id,
              label: provider.catalog.postureControl.label,
              modes: provider.catalog.postureControl.modes.map((mode) => ({ ...mode }))
            }
          }
        : {})
    }))
  }
}

export {
  createAntigravityManagedHookPlan,
  createClaudeManagedHookPlan,
  createCodexManagedHookPlan,
  createHermesManagedHookPlan
} from './providers/index.js'
export {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  sanitizeBracketedPasteText,
  wrapBracketedPasteText,
  buildPromptInputPayload
} from './providers/shared.js'
