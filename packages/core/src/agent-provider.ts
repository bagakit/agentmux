import type { AgentPromptPreparationWaitReason } from './prompt-preparation.js'
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
  normalizeTerminalInteractionCompletion,
  type AgentPostureProtocol,
  type AgentTerminalInteractionProtocol,
  type PostureControlDeclaration
} from './agent-interaction.js'
import { normalizeNativeHook, type AgentNativeHookSpecification } from './hook-normalizer.js'
import type { AgentManagedHookPlan } from './managed-hook-installer.js'
import { createBuiltInAgentProviders } from './providers/index.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentProviderId,
  AgentLaunchPlan,
  AgentMuxInteractionInputPlan,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRunRef,
  AgentNativeSessionHandle,
  AgentPostureInputPlan,
  AgentPromptInputPlan,
  AgentPromptExecution,
  AgentPromptExecutionContext,
  AgentPromptExecutionEvidence,
  AgentProviderSessionStatus,
  AgentNativePromptPredecessor,
  AgentHookReceipt,
  AgentTerminalScreenSnapshot,
  AgentProviderLaunchContext,
  AgentProviderResumeContext,
  AgentProviderForkContext,
  AgentProviderNativeSessionDiscovery,
  AgentProviderNativeSessionDiscoveryContext,
  AgentProviderNativeSessionListContext,
  AgentProviderNativeResumeContext,
  AgentNativeSessionCatalog,
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryRecordContext,
  AgentSessionHistoryItem,
  AgentProviderSessionQuestionReplyContext,
  AgentProviderSessionHistoryPage,
  AgentProviderSessionHistoryObservationContext,
  AgentSessionHistoryObservationHandle,
  AgentTerminalHandshake,
  AgentTerminalPromptRenderMatcher,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

export type AgentExecutableProbe = {
  hasExecutable(executable: string): Promise<boolean>
}

export type AgentManagedHookPlanContext = {
  workspacePath: string
  env?: Readonly<Record<string, string>>
  endpoint?: { url: string; token: string }
}

export type AgentProviderHookActivationContext = {
  plan: AgentManagedHookPlan
  workspacePath: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  signal: AbortSignal
}

export type AgentProviderHookActivation = { active: boolean; code: string; action: string | null }

export type AgentProviderHookNormalizationContext = Readonly<{
  nativeHandle?: Readonly<AgentNativeSessionHandle>
  /** Only the existing durable receipt of this exact Core Run. */
  previousHookReceipt?: Readonly<AgentHookReceipt>
  /** This Run was started for an exact semantic resume target; Hook observations cannot redirect it. */
  protectedNativeTarget?: boolean
  processNativeHandle?: Readonly<AgentNativeSessionHandle>
  processNativeChildSessionIds?: readonly string[]
  nativeIdentityReason?: string
}>

export type AgentProviderPromptExecutionContext = {
  /** Present only for the executing Core Host's local Runtime-owned process. */
  processId?: number
  /** Exact Provider source being authorized; diagnostics must bind this source. */
  nativeSourceId?: string
  args: readonly string[]
  workspacePath: string
  nativeHandle?: Readonly<AgentNativeSessionHandle>
  /** Only the exact current Core Run can consume its pre-resume native evidence. */
  nativePromptPredecessor?: Readonly<AgentNativePromptPredecessor>
  /** Cancellation abandons only this read-only observation, never the Agent. */
  signal?: AbortSignal
}

export type AgentProviderPreparedPromptTransport = Readonly<{
  nativeSourceId: string
  /** A fresh check of the original native writer/source, never cached input authorization. */
  verifyCurrentTransport(context: AgentProviderPromptExecutionContext): Promise<boolean>
}>

/** Ephemeral qualification from the existing screen owner, never a second input journal. */
export type AgentInteractionTargetFrame = Readonly<{
  run: Readonly<AgentMuxRunRef>
  outputThroughByte: number
  geometryRevision: number
  evidenceGeneration: number
}>

export type AgentProviderInteractionResponseContext = AgentProviderPromptExecutionContext & Readonly<{
  agentSessionId: string
  run: Readonly<AgentMuxRunRef>
  inputByte: number
  signal: AbortSignal
  observeTarget(inspect: (screen: AgentTerminalScreenSnapshot) => boolean): Promise<AgentInteractionTargetFrame>
}>

export type AgentProviderPreparedInteractionResponse = Readonly<{
  plan: AgentMuxInteractionInputPlan
  target: Readonly<{
    agentSessionId: string
    run: Readonly<AgentMuxRunRef>
    requestId: string
    nativeToolCallId: string
    nativeSourceId: string
    inputByte: number
    frame: AgentInteractionTargetFrame
  }>
  inspectCurrentTarget(screen: AgentTerminalScreenSnapshot): boolean
  /** Re-read the same native invocation/source immediately before a new input claim. */
  verifyCurrentTarget(context: AgentProviderPromptExecutionContext): Promise<boolean>
}>
export type AgentProviderSessionStatusContext = AgentProviderPromptExecutionContext & { signal: AbortSignal }
export type AgentProviderSessionStatusObservationContext = AgentProviderSessionStatusContext & {
  onStatus(status: AgentProviderSessionStatus): void
  onUnavailable(code: string, message: string): void
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
  /** This contribution is the native history capability; its absence is explicitly unsupported. */
  discoverNativeSession?(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionDiscovery | null>
  /** Persisted conversation discovery is independent of a currently managed Run. */
  listNativeSessions?(context: AgentProviderNativeSessionListContext): Promise<Omit<AgentNativeSessionCatalog, 'capabilities'>>
  /** Recheck only this exact selected source before starting its native resume. */
  assertNativeResumeSource?(context: AgentProviderNativeResumeContext): Promise<void>
  readSessionHistoryPage?(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage>
  readSessionHistoryRecord?(context: AgentProviderSessionHistoryRecordContext): Promise<AgentSessionHistoryItem>
  prepareSessionQuestionReply?(context: AgentProviderSessionQuestionReplyContext): Promise<string>
  observeSessionHistory?(context: AgentProviderSessionHistoryObservationContext): Promise<AgentSessionHistoryObservationHandle>
  /** Managed configuration is contributed by this object; null means the exact context is unavailable. */
  planManagedHooks?(context: AgentManagedHookPlanContext): AgentManagedHookPlan | null
  inspectHookActivation?(context: AgentProviderHookActivationContext): Promise<AgentProviderHookActivation>
  probeCapabilities(probe: AgentExecutableProbe, commandOverride?: string): Promise<AgentCapabilitySnapshot>
  buildLaunch(context: AgentProviderLaunchContext): AgentLaunchPlan
  buildResumeLaunch(context: AgentProviderResumeContext): AgentLaunchPlan
  buildForkLaunch?(context: AgentProviderForkContext): AgentLaunchPlan
  resolveLaunchArgv(selections: LaunchOptionSelection): string[]
  planPromptInput(prompt: string, context?: { execution?: AgentPromptExecution; intent?: 'question-reply'; terminalScreen?: AgentTerminalScreenSnapshot }): AgentPromptInputPlan
  /** Provider owns native terminal decoding; unavailable refuses only this immediate operation. */
  inspectPromptExecution?(screen: AgentTerminalScreenSnapshot, strategy?: NonNullable<AgentCatalogEntry['capabilities']['promptExecution']>['immediate']): AgentPromptExecutionContext
  /** Complete current composer reason only; this observation never authorizes input. */
  inspectPromptPreparationWait?(screen: AgentTerminalScreenSnapshot, strategy?: NonNullable<AgentCatalogEntry['capabilities']['promptExecution']>['immediate']): AgentPromptPreparationWaitReason | undefined
  verifyPromptExecutionTransport?(context: AgentProviderPromptExecutionContext): Promise<boolean>
  preparePromptExecutionTransport?(context: AgentProviderPromptExecutionContext & { signal: AbortSignal }): Promise<AgentProviderPreparedPromptTransport | null>
  readPromptExecutionEvidence?(context: AgentProviderPromptExecutionContext): Promise<AgentPromptExecutionEvidence | null>
  prepareInteractionResponse?(
    context: AgentProviderInteractionResponseContext,
    request: Readonly<AgentMuxInteractionRequest>,
    response: Readonly<AgentMuxInteractionResponse>
  ): Promise<AgentProviderPreparedInteractionResponse | null>
  observeSessionStatus?(context: AgentProviderSessionStatusObservationContext): Promise<{ dispose(): void }>
  planInteractionResponse(
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse
  ): AgentMuxInteractionInputPlan
  planPostureSet(modeId: string): AgentPostureInputPlan
  normalizeHook(
    envelope: NativeHookEnvelope,
    context: AgentProviderHookNormalizationContext
  ): NormalizedHookEvent
}

export type AgentCatalogSeed = Omit<AgentCatalogEntry, 'readySignal' | 'launchOptions'>

export type AgentProviderDefinition = {
  catalog: Omit<AgentCatalogEntry, 'launchOptions'>
  buildArgs(prompt: string, args: readonly string[]): string[]
  hook: AgentNativeHookSpecification
  launchOptions?: readonly LaunchOptionDeclaration[]
  terminalHandshake?: AgentTerminalHandshake
  terminalPromptRender?: AgentTerminalPromptRenderMatcher
  discoverNativeSession?: (context: AgentProviderNativeSessionDiscoveryContext) => Promise<AgentProviderNativeSessionDiscovery | null>
  listNativeSessions?: AgentProvider['listNativeSessions']
  assertNativeResumeSource?: AgentProvider['assertNativeResumeSource']
  readSessionHistoryPage?: (context: AgentProviderSessionHistoryContext) => Promise<AgentProviderSessionHistoryPage>
  readSessionHistoryRecord?: (context: AgentProviderSessionHistoryRecordContext) => Promise<AgentSessionHistoryItem>
  prepareSessionQuestionReply?: (context: AgentProviderSessionQuestionReplyContext) => Promise<string>
  observeSessionHistory?: (context: AgentProviderSessionHistoryObservationContext) => Promise<AgentSessionHistoryObservationHandle>
  planManagedHooks?: (context: AgentManagedHookPlanContext) => AgentManagedHookPlan | null
  inspectHookActivation?: (context: AgentProviderHookActivationContext) => Promise<AgentProviderHookActivation>
  buildResumeArgs?: (
    sessionId: string,
    transcriptPath: string | undefined,
    prompt: string | undefined,
    args: readonly string[]
  ) => string[]
  buildForkArgs?: (
    sessionId: string,
    transcriptPath: string | undefined,
    prompt: string | undefined,
    args: readonly string[]
  ) => string[]
  planPromptInput?: (prompt: string, context?: { execution?: AgentPromptExecution; intent?: 'question-reply'; terminalScreen?: AgentTerminalScreenSnapshot }) => AgentPromptInputPlan
  inspectPromptExecution?: (screen: AgentTerminalScreenSnapshot, strategy?: NonNullable<AgentCatalogEntry['capabilities']['promptExecution']>['immediate']) => AgentPromptExecutionContext
  inspectPromptPreparationWait?: AgentProvider['inspectPromptPreparationWait']
  verifyPromptExecutionTransport?: (context: AgentProviderPromptExecutionContext) => Promise<boolean>
  preparePromptExecutionTransport?: AgentProvider['preparePromptExecutionTransport']
  readPromptExecutionEvidence?: (context: AgentProviderPromptExecutionContext) => Promise<AgentPromptExecutionEvidence | null>
  prepareInteractionResponse?: AgentProvider['prepareInteractionResponse']
  observeSessionStatus?: (context: AgentProviderSessionStatusObservationContext) => Promise<{ dispose(): void }>
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

export function resolveAgentExecutable(commandOverride: string | undefined, defaultCommand: string): string {
  const command = commandOverride?.trim() || defaultCommand
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

/** Reject incomplete new contributions before they can replace a registered Provider. */
function assertManagedHookContribution(contribution: {
  catalog: Pick<AgentCatalogEntry, 'id' | 'hookStrategy'>
  planManagedHooks?: AgentProvider['planManagedHooks']
}): void {
  const strategy = contribution.catalog.hookStrategy
  const managed = strategy.kind === 'native' && strategy.installation === 'explicit-managed'
  if (managed ? typeof contribution.planManagedHooks !== 'function' : contribution.planManagedHooks !== undefined) {
    throw new AgentMuxError(
      `Provider ${contribution.catalog.id} must declare managed Hook planning exactly when its Hook installation is explicit-managed.`,
      'INVALID_AGENT_PROVIDER'
    )
  }
}

export function defineAgentProvider(definition: AgentProviderDefinition): AgentProvider {
  assertManagedHookContribution(definition)
  if (Boolean(definition.listNativeSessions) !== Boolean(definition.assertNativeResumeSource)) {
    throw new AgentMuxError('Native conversation discovery and exact source verification must be contributed together.', 'INVALID_AGENT_PROVIDER')
  }
  const { catalog: catalogSeed } = definition
  if (Boolean(catalogSeed.capabilities.providerFork?.current) !== Boolean(definition.buildForkArgs)) {
    throw new AgentMuxError('Native fork capability and its launch contribution must be declared together.', 'INVALID_AGENT_PROVIDER')
  }
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
  const immediateStrategy = catalogSeed.capabilities.promptExecution?.immediate
  if (immediateStrategy !== undefined) {
    if (immediateStrategy !== 'interrupt-before-input' && immediateStrategy !== 'native-steer') {
      throw new AgentMuxError('Provider immediate strategy is invalid.', 'INVALID_AGENT_PROVIDER')
    }
    for (const probe of ['probe', 'probe\nsecond-line']) {
      const plan = definition.planPromptInput?.(probe, { execution: 'immediate' })
      if (plan?.kind !== 'render-then-submit' ||
          Boolean(plan.prepare) !== (immediateStrategy === 'interrupt-before-input') ||
          !definition.inspectPromptExecution ||
          immediateStrategy === 'native-steer' && (!definition.readPromptExecutionEvidence || !definition.verifyPromptExecutionTransport)) {
        throw new AgentMuxError('Provider immediate strategy and its native input contribution are inconsistent.', 'INVALID_AGENT_PROVIDER')
      }
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
    ...(definition.inspectPromptExecution ? { inspectPromptExecution: definition.inspectPromptExecution } : {}),
    ...(definition.inspectPromptPreparationWait ? { inspectPromptPreparationWait: definition.inspectPromptPreparationWait } : {}),
    ...(definition.verifyPromptExecutionTransport ? { verifyPromptExecutionTransport: definition.verifyPromptExecutionTransport } : {}),
    ...(definition.preparePromptExecutionTransport ? { preparePromptExecutionTransport: definition.preparePromptExecutionTransport } : {}),
    ...(definition.readPromptExecutionEvidence ? { readPromptExecutionEvidence: definition.readPromptExecutionEvidence } : {}),
    ...(definition.prepareInteractionResponse ? { prepareInteractionResponse: definition.prepareInteractionResponse } : {}),
    ...(definition.observeSessionStatus ? { observeSessionStatus: definition.observeSessionStatus } : {}),
    ...(definition.discoverNativeSession ? { discoverNativeSession: definition.discoverNativeSession } : {}),
    ...(definition.listNativeSessions ? { listNativeSessions: definition.listNativeSessions } : {}),
    ...(definition.assertNativeResumeSource ? { assertNativeResumeSource: definition.assertNativeResumeSource } : {}),
    ...(definition.readSessionHistoryPage ? { readSessionHistoryPage: definition.readSessionHistoryPage } : {}),
    ...(definition.readSessionHistoryRecord ? { readSessionHistoryRecord: definition.readSessionHistoryRecord } : {}),
    ...(definition.prepareSessionQuestionReply ? { prepareSessionQuestionReply: definition.prepareSessionQuestionReply } : {}),
    ...(definition.observeSessionHistory ? { observeSessionHistory: definition.observeSessionHistory } : {}),
    ...(definition.planManagedHooks ? { planManagedHooks: definition.planManagedHooks } : {}),
    ...(definition.inspectHookActivation ? { inspectHookActivation: definition.inspectHookActivation } : {}),
    ...(definition.buildForkArgs ? { buildForkLaunch(context: AgentProviderForkContext): AgentLaunchPlan {
      const handle = context.nativeHandle
      if (handle.kind !== 'provider' || handle.providerId !== catalog.id) {
        throw new AgentMuxError('Native fork source does not belong to this Provider.', 'INVALID_NATIVE_SESSION_HANDLE')
      }
      const prompt = context.prompt?.trim() ? context.prompt : undefined
      if (prompt && catalog.promptDelivery === 'post-launch-only') {
        throw new AgentMuxError(`${catalog.label} cannot receive a prompt at launch; fork it first, then submit the prompt.`, 'AGENT_LAUNCH_PROMPT_UNSUPPORTED')
      }
      return { command: resolveAgentExecutable(context.commandOverride, catalog.executable),
        args: definition.buildForkArgs!(handle.sessionId, handle.transcriptPath, prompt, context.args), env: { ...context.env } }
    } } : {}),
    async probeCapabilities(probe, commandOverride) {
      const command = resolveAgentExecutable(commandOverride, catalog.executable)
      return {
        providerId: catalog.id,
        executable: command,
        installed: await probe.hasExecutable(command),
        capabilities: { ...catalog.capabilities }
      }
    },
    buildLaunch(context) {
      const prompt = context.prompt.trim() ? context.prompt : ''
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
        command: resolveAgentExecutable(context.commandOverride, catalog.executable),
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
      const resumePrompt = context.prompt?.trim() ? context.prompt : undefined
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
        command: resolveAgentExecutable(context.commandOverride, catalog.executable),
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
    planPromptInput(prompt, context) {
      const plan = definition.planPromptInput?.(prompt, context) ?? { kind: 'single-phase' as const, data: `${prompt}\r` }
      const strategy = catalog.capabilities.promptExecution?.immediate
      if (context?.execution === 'immediate' &&
          (!strategy || plan.kind !== 'render-then-submit' ||
           Boolean(plan.prepare) !== (strategy === 'interrupt-before-input') || !definition.inspectPromptExecution)) {
        throw new AgentMuxError(`${catalog.label} has no safe native immediate input plan. The message and healthy Run are retained; ordinary terminal input remains available.`,
          'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED')
      }
      return plan
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
    normalizeHook(envelope, context) {
      if (envelope.providerId !== catalog.id) {
        throw new AgentMuxError('Hook event does not belong to this provider.', 'HOOK_PROVIDER_MISMATCH')
      }
      const previous = context.previousHookReceipt
      const correlationContext = previous && (previous.agentSessionId !== envelope.agentSessionId ||
        previous.providerId !== envelope.providerId || previous.run.runId !== envelope.runId)
        ? { ...(context.nativeHandle ? { nativeHandle: context.nativeHandle } : {}) } : context
      const normalized = normalizeNativeHook(definition.hook, envelope, correlationContext)
      const resolvedEnvelope = envelope.eventName === normalized.eventName
        ? envelope
        : { ...envelope, eventName: normalized.eventName }
      const mainInteraction = normalized.mainSubject ? definition.interaction : undefined
      const interaction = mainInteraction
        ? normalizeTerminalInteraction(resolvedEnvelope, normalized.status.observedAt, mainInteraction,
          definition.hook.resolveInteractionToolCallId?.(normalized.eventName, resolvedEnvelope.payload ?? {}, correlationContext))
        : undefined
      const interactionCompletion = mainInteraction
        ? normalizeTerminalInteractionCompletion(resolvedEnvelope, normalized.status.observedAt, mainInteraction) : undefined
      return { ...normalized, ...(interaction ? { interaction } : {}),
        ...(interactionCompletion ? { interactionCompletion } : {}) }
    }
  }
}

export const BUILT_IN_AGENT_PROVIDERS: readonly AgentProvider[] = createBuiltInAgentProviders(defineAgentProvider)

export class AgentProviderRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>()

  constructor(providers: readonly AgentProvider[] = BUILT_IN_AGENT_PROVIDERS) {
    this.registerAll(providers)
  }

  register(provider: AgentProvider): void {
    this.registerAll([provider])
  }

  /** Reject the whole contribution before making any of its Providers discoverable. */
  registerAll(providers: readonly AgentProvider[]): void {
    const ids = new Set(this.providers.keys())
    for (const provider of providers) {
      assertManagedHookContribution(provider)
      if (ids.has(provider.id)) {
        throw new AgentMuxError(`Agent provider already registered: ${provider.id}`, 'DUPLICATE_PROVIDER')
      }
      ids.add(provider.id)
    }
    for (const provider of providers) this.providers.set(provider.id, provider)
  }

  replace(provider: AgentProvider): void {
    assertManagedHookContribution(provider)
    this.providers.set(provider.id, provider)
  }

  unregister(id: AgentProviderId): void { this.providers.delete(id) }

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
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  sanitizeBracketedPasteText,
  wrapBracketedPasteText,
  buildPromptInputPayload
} from './providers/shared.js'
