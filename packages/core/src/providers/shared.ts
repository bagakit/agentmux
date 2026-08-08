import { existsSync } from 'node:fs'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { resolveCoreBinPath } from '../runtime-paths.js'
import type { BuiltInAgentProviderId } from '../agent-provider-id.js'
import type { AgentCatalogEntry, AgentHookStrategy, AgentProviderId } from '../types.js'

export type ManagedHookPlanBuilder = (
  workspacePath: string,
  env?: Readonly<Record<string, string>>
) => AgentManagedHookPlan

/** Add the common foreground-process readiness signal to a provider catalog seed. */
export function catalog(input: Omit<AgentCatalogEntry, 'readySignal' | 'launchOptions'>): Omit<AgentCatalogEntry, 'launchOptions'> {
  return {
    ...input,
    readySignal: { kind: 'foreground-process', expectedProcess: input.expectedProcess }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Resolve the hook runner, refusing to hand back a path that is not there.
 *
 * `resolveCoreBinPath` falls back to its first candidate when every candidate is missing, which is the
 * right shape for `AGENTMUX_CLI_PATH` (evaluated at module load — throwing there would break the import
 * for everyone, including callers that never shell out). It is the wrong shape here: the string this
 * returns gets frozen into the user's own hooks config on disk. A packaging slip that drops
 * `agentmux-hook.js` — the packaged layout resolves through `process.resourcesPath`, a set of candidates
 * that simply do not exist in a dev tree — would write a command pointing at a file that is not there,
 * and nothing downstream checks: the installer writes whatever bytes it is given, and the provider CLI
 * silently fails to spawn the hook. The user sees an Agent that never reports status while its config
 * file looks correctly installed.
 *
 * Failing loudly instead lands in `ensureManagedHooks`'s best-effort catch, which surfaces a non-fatal
 * `agent-error` naming the provider and still launches the Agent — its terminal output stays observable.
 * So the cost of this check is one honest error message; the cost of skipping it is a silent lie.
 */
function hookRunnerPath(): string {
  const commandPath = resolveCoreBinPath('agentmux-hook.js')
  if (!existsSync(commandPath)) {
    throw new AgentMuxError(
      `Managed Hook runner is missing at ${commandPath}; refusing to write a hook command that cannot run.`,
      'HOOK_RUNNER_MISSING'
    )
  }
  return commandPath
}

/**
 * Build the managed hook command written into a provider's hooks config.
 *
 * The path is resolved now and frozen into the user's config file, so it must exist now — see
 * `hookRunnerPath`. `process.execPath` is likewise this process's interpreter, which is what makes the
 * written command reproducible for the CLI that will read it.
 */
export function managedHookCommand(providerId: AgentProviderId): string {
  const commandPath = hookRunnerPath()
  return `ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

/** Hermes invokes shell hooks with shlex.split(...), shell=False. */
export function hermesHookCommand(): string {
  const commandPath = hookRunnerPath()
  return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote('hermes')} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

/**
 * Bracketed-paste 的字节判定住在 `../bracketed-paste.js`——一个不 import 任何 `node:` 内置的叶子模块。
 *
 * 本文件第一行就是 `import { existsSync } from 'node:fs'`，渲染进程到不了这里；而终端粘贴路径
 * （用户按 Cmd+V 或右键 Paste）与这里的 prompt 投递是**同一个概念**：一段文本要进 PTY，ESC 怎么办。判定
 * 若留在这里，渲染层唯一的出路就是再手抄一份——那正是本仓最常复发的缺陷族。这里保留 re-export 只为不动
 * 既有消费者（`codex.ts` 直接 import，`agent-provider.ts` 的公共 re-export 块也从这里取）。
 */
export {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  sanitizeBracketedPasteText,
  wrapBracketedPasteText,
  buildPromptInputPayload
} from '../bracketed-paste.js'

/**
 * 受管 Hook 命令的执行超时（秒）——**值的 SSOT**。每个 Provider 的 hook 配置都要给它写超时。
 *
 * 之所以集中：这个值曾在九个 provider 文件（antigravity 两处，共十处）里各手抄一份 `10`，其中 copilot
 * 还用的是**另一个字段名** `timeoutSec`（见 copilot.ts 文件头：那个 CLI 的键带单位后缀，写 `timeout`
 * 会被静默剥掉、退回它自己的默认超时）。这里把「值」与「每家用哪个键」都收成 SSOT——见
 * {@link HOOK_COMMAND_TIMEOUT_FIELD} 与 {@link hookCommandTimeout}——各 Provider 不再自己拼这个属性位。
 */
export const HOOK_COMMAND_TIMEOUT_SECONDS = 10

/**
 * 每家内置 Provider 的 hook 命令超时**字段名**——键拼法的 SSOT，与值 SSOT 并列。
 *
 * 为什么键也要 SSOT 化、而不是只集中那个 `10`：字段名本身就漂移过。九家写裸的 `timeout`，copilot 必须写
 * `timeoutSec`（上游要求，`copilot.ts` 头部有实测记录）。只集中值、让各文件自己拼键，就等于把 copilot
 * 的正确拼法交给「下一个人抄的时候记不记得」——抄错成 `timeout` 不报错、不发红，只是 copilot 的 hook 静默
 * 换了超时。把「每家用哪个键」物化成这张表后，键与值一起从 {@link hookCommandTimeout} 派生，属性位不再有人
 * 手写。
 *
 * `null` = 这家**不写**命令级 hook 超时：`traex`（无 hook）、`kimi`（TOML `[[hooks]]`，非本仓 merge 面）、
 * `pi`/`opencode`（同进程插件直接 POST，根本没有 `{type:'command'}` 那条超时字段）。把它们显式记 `null`
 * 而不是省略，是为了让 `satisfies Record<BuiltInAgentProviderId, …>` 强制**每加一家新 Provider 都必须表态**
 * 它用哪个键或不写——漏一家会编译失败（见 test/provider-hook-timeout-source.test.ts 的编译期实验）。
 */
export const HOOK_COMMAND_TIMEOUT_FIELD = {
  codex: 'timeout',
  claude: 'timeout',
  traex: null,
  hermes: 'timeout',
  pi: null,
  grok: 'timeout',
  gemini: 'timeout',
  antigravity: 'timeout',
  cursor: 'timeout',
  kimi: null,
  droid: 'timeout',
  copilot: 'timeoutSec',
  opencode: null
} as const satisfies Record<BuiltInAgentProviderId, 'timeout' | 'timeoutSec' | null>

/** 会写命令级 hook 超时的 Provider（映射值非 `null` 的那几家）。 */
export type ProviderWithHookCommandTimeout = {
  [K in BuiltInAgentProviderId]: (typeof HOOK_COMMAND_TIMEOUT_FIELD)[K] extends null ? never : K
}[BuiltInAgentProviderId]

/**
 * 一家 Provider 的 hook 超时属性位——键与值都来自 SSOT，调用方 `spread` 进 hook 条目即可，属性位不再手写。
 *
 * 键用计算属性 `[HOOK_COMMAND_TIMEOUT_FIELD[providerId]]` 从上面那张表取，值来自
 * {@link HOOK_COMMAND_TIMEOUT_SECONDS}；两者都没有可供手抄的字面量。入参类型限制为
 * {@link ProviderWithHookCommandTimeout}，所以拿一家映射为 `null` 的 Provider（如 `kimi`）来调它是编译错误——
 * 那几家本就不该写这个属性位。
 *
 * 结构守卫（test/provider-hook-timeout-source.test.ts）额外用 TypeScript 类型检查器证明：`providers/` 下
 * `timeout`/`timeoutSec` 这两个属性位上再没有裸数字，且这里返回的对象的值就是那个导出常量本身（不是恰好等于
 * `10` 的另一处字面量）——行为等价挡不住「新抄一份 `10`」，只有类型检查器解析到同一个符号才挡得住。
 */
export function hookCommandTimeout(providerId: ProviderWithHookCommandTimeout): Record<string, number> {
  return { [HOOK_COMMAND_TIMEOUT_FIELD[providerId]]: HOOK_COMMAND_TIMEOUT_SECONDS }
}

/** hook 安装归属的三档取值，直接从 {@link AgentHookStrategy} 派生——类型层某天加一档，这里自动跟着变宽。 */
type HookInstallationKind =
  | Extract<AgentHookStrategy, { kind: 'none' }>['kind']
  | Extract<AgentHookStrategy, { kind: 'native' }>['installation']

/**
 * 每家内置 Provider 的 hook 安装归属——**分类的 SSOT**，与各 catalog 的 `hookStrategy` 是同一事实的两处投影。
 *
 * 为什么必须把这个分类单独物化成一张**字面量**表、而不能从 catalog 在类型层派生：catalog 由工厂函数
 * （`createCodexProvider(...)` 等）产出，返回类型一律拓宽成 `AgentProvider`，其 `hookStrategy` 是联合类型
 * {@link AgentHookStrategy}——每家自己写的 `installation: 'explicit-managed'` 这个**字面量**在工厂边界上就被
 * 擦成了整个联合。于是「谁是 explicit-managed」在类型层从 catalog **取不回来**，编译器在
 * {@link MANAGED_HOOK_PLAN_RESOLVERS} 那张 resolver 表上什么都强制不了（这正是 `AgentProviderId` 拓宽成
 * `string` 之外的第二重障碍）。把分类抄成这一张 `satisfies Record<BuiltInAgentProviderId, …>` 的表后，它成为
 * 类型层能拿在手里的 SSOT：{@link ProviderRequiringManagedHookResolver} 从它派生，resolver 表拿它当键域，
 * 漏一家 `explicit-managed` 直接编译失败。
 *
 * 这张表与各 catalog 是两处投影、天然会漂——由 test/provider-conformance.test.ts 逐 id 双向钉死：表里的
 * 分类必须等于该 provider catalog 的 `hookStrategy` 实际分类，任一侧改了另一侧没跟上就红。所以引入这份 copy
 * 没有留下无人守的缝。
 */
export const HOOK_INSTALLATION_BY_PROVIDER = {
  codex: 'explicit-managed',
  claude: 'explicit-managed',
  traex: 'none',
  hermes: 'explicit-managed',
  pi: 'explicit-managed',
  grok: 'explicit-managed',
  gemini: 'explicit-managed',
  antigravity: 'explicit-managed',
  cursor: 'explicit-managed',
  kimi: 'unmanaged',
  droid: 'explicit-managed',
  copilot: 'explicit-managed',
  opencode: 'explicit-managed'
} as const satisfies Record<BuiltInAgentProviderId, HookInstallationKind>

/**
 * 声明了 `explicit-managed`、因而**必须**在 {@link MANAGED_HOOK_PLAN_RESOLVERS} 里挂一条 resolver 的那批
 * Provider（即 {@link HOOK_INSTALLATION_BY_PROVIDER} 里映射为 `'explicit-managed'` 的键）。
 *
 * 只有这批被强制。映射为 `'none'`（traex：根本没有 hook）或 `'unmanaged'`（kimi：有原生 hook 但配置面
 * 不由 AgentMux 安装）的**不**要求 resolver——它们本就不该有一份被 AgentMux 写盘的计划。这与
 * {@link ProviderWithHookCommandTimeout} 同构：都从一张 `satisfies Record<BuiltInAgentProviderId, …>` 的
 * 分类表里筛出「该被强制的那批键」。
 */
export type ProviderRequiringManagedHookResolver = {
  [K in BuiltInAgentProviderId]: (typeof HOOK_INSTALLATION_BY_PROVIDER)[K] extends 'explicit-managed' ? K : never
}[BuiltInAgentProviderId]