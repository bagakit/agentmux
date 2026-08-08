import { AgentMuxError } from './errors.js'
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
  /**
   * 这个 Provider 的原生 hook 声明（rules / subagentTracking / nativeHandle / eventNameSource）。
   *
   * 暴露它是为了让跨 Provider 的守卫能从**注册表**（「有哪些 Provider」的 SSOT）枚举每家的 hook 合同，
   * 而不必在测试里手抄一份「12 个 HOOKS 常量」的 import 清单——那种清单会在新接一家时静默漏掉它。
   */
  readonly hook: AgentNativeHookSpecification
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
  // 渲染合同的定义期不变式：`terminalPromptRender`（渲染匹配器）与 `planPromptInput` 产出的
  // `render-then-submit` 两阶段计划必须**同时在场或同时缺席**。
  //
  // 为什么必须在此刻响亮地失败——这两者是同一条 prompt 通路的两半，却分居两处声明，谁也不强制对方在场：
  //   1. 声明了 render-then-submit 却漏了匹配器：readiness 纪元从不被 arm（arm 的两条路——client.ts
  //      握手期与 native-stop 期——都 gate 在 `terminalPromptRender` 上，`observeReadiness` 自己第一行
  //      也是 `if (!matcher) return`），于是发往这个 Provider 的**每一条** prompt 都在 `claimPromptReadiness`
  //      里被 `AGENT_PROMPT_NOT_READY`（reason=epoch-missing）拒掉。没有编译错、没有红测试：一个新接的
  //      Provider「装上了但一条 prompt 都发不出去」，而所有其它测试照旧全绿。这正是本 lane 要消灭的
  //      「半成功」——它此前只在**用户**发第一条 prompt 时才现形。
  //   2. 声明了匹配器却用单阶段计划：readiness 被 arm 却永不被消费（提交走单阶段、不看 readiness），
  //      屏幕证据观察白做。
  // 两个方向都判：两处声明各自都可能先落地、后落地。provider-render-conformance.test.ts 早已守了
  // 「匹配器 ⟹ render-then-submit」一侧；反向那侧（本 lane 的静默杀手）此前无人守。
  //
  // 判据用**探针**而非某个声明字段：`planPromptInput` 的返回是运行时才定的联合，无法在类型层表达
  // 「它到底产哪一种」，探它是唯一诚实的来源（那条 conformance 测试也这么探）。**盲点（务必知道）**：
  // 只探两个代表性 prompt（单行 / 多行）。一个「按 prompt 内容切换计划种类」的 Provider 本就不被这套
  // 机制支持——readiness 在不知道 prompt 内容时就已 arm——故这里假定计划种类对一个 Provider 稳定；
  // 两个探针里只要有一个与匹配器在场不一致就抛。
  const producesRenderThenSubmit = (prompt: string): boolean =>
    (definition.planPromptInput?.(prompt) ?? { kind: 'single-phase' as const }).kind === 'render-then-submit'
  const hasRenderMatcher = Boolean(definition.terminalPromptRender)
  for (const probe of ['probe', 'probe\nsecond-line']) {
    const rendersTwoPhase = producesRenderThenSubmit(probe)
    if (rendersTwoPhase !== hasRenderMatcher) {
      throw new AgentMuxError(
        `${catalogSeed.label} couples its terminal prompt-render matcher and its render-then-submit plan inconsistently; declare both or neither.`,
        'INVALID_AGENT_PROVIDER',
        `providerId=${catalogSeed.id} hasRenderMatcher=${hasRenderMatcher} rendersTwoPhase=${rendersTwoPhase}`
      )
    }
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
    hook: definition.hook,
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
  env?: Readonly<Record<string, string>>,
  endpoint?: { url: string; token: string }
): AgentManagedHookPlan | null {
  return MANAGED_HOOK_PLAN_RESOLVERS[providerId]?.(workspacePath, env, endpoint) ?? null
}

export const BUILT_IN_AGENT_PROVIDERS: readonly AgentProvider[] = createBuiltInAgentProviders(defineAgentProvider)

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
