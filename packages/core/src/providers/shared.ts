import { readManagedHookTarget } from '../managed-hook-installer.js'
import type { AgentProviderHookActivation, AgentProviderHookActivationContext } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { LAUNCH_SCOPED_HOOK_FLAG } from '../launch-scoped-hook.js'
import type { ManagedHookRuntime } from '../managed-hook-runtime.js'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from '../hook-command-timeout.js'
import { passiveHookResponses } from '../hook-passive-response.js'
export { HOOK_COMMAND_TIMEOUT_SECONDS } from '../hook-command-timeout.js'
import type { BuiltInAgentProviderId } from '../agent-provider-id.js'
import type { AgentCatalogEntry, AgentProviderId } from '../types.js'
import type { AgentNativeHookToolFields } from '../hook-normalizer.js'

/** Pack fields already selected by one Provider; this helper knows no protocol keys. */
export function hookToolFields(name: unknown, input: unknown, reportedId?: unknown): AgentNativeHookToolFields {
  const toolName = typeof name === 'string' ? name.trim() : undefined
  const reportedToolCallId = typeof reportedId === 'string' ? reportedId.trim() : undefined
  return { ...(toolName ? { toolName } : {}), ...(input === undefined ? {} : { toolInput: input }),
    ...(reportedToolCallId ? { reportedToolCallId } : {}) }
}

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
 * The command a launch-carried Hook runs. It names no install path: the launching Core puts its own
 * Node and runner in the Run environment ({@link retainedHookEnvironment}), so one declaration
 * serves every install. Outside such a Run both are unset and the shell test answers the passive `{}`
 * (Codex requires JSON on Stop), so a session started elsewhere never reports a Hook error for it.
 */
export function runScopedHookCommand(providerId: AgentProviderId): string {
  const cases = Object.entries(passiveHookResponses(providerId)).map(([event, response]) =>
    `${shellQuote(event)}) printf '%s' ${shellQuote(response)} ;;`).join('\n')
  const script = `event=
previous=
for argument in "$@"; do
  if [ "$previous" = '--event' ]; then event="$argument"; break; fi
  previous="$argument"
done
passive() {
  case "$event" in
${cases}
    *) printf '{}\\n' ;;
  esac
}
if [ "\${AGENTMUX_ENV-}" != '1' ] || [ "\${AGENTMUX_PROVIDER_ID-}" != ${shellQuote(providerId)} ]; then
  passive
  exit 0
fi
if [ ! -x "\${AGENTMUX_HOOK_NODE-}" ] || [ ! -f "\${AGENTMUX_HOOK_RUNNER-}" ]; then
  passive
  printf '%s\\n' '[AgentMux Hook] The original Run runtime is unavailable; Hook delivery is unconfirmed. The native Agent remains available.' >&2
  exit 0
fi
ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} exec "$AGENTMUX_HOOK_NODE" "$AGENTMUX_HOOK_RUNNER" ${LAUNCH_SCOPED_HOOK_FLAG} "$@"`
  // argv[0] is explicit: native consumers may append --event and shell=False
  // consumers can execute this argv without doing their own variable expansion.
  return `/bin/sh -c ${shellQuote(script)} amux-hook`
}

/**
 * Scope distinguishes this Run's prepared declaration from leftover callbacks, whether the
 * native definition travels at launch or lives in shared config. Always clear inherited values.
 * Preparation failure keeps any available runtime but disables only duplicate suppression;
 * Core has already reported that the native carrier is unconfirmed.
 */
export function retainedHookEnvironment(scoped: boolean, carrierReady = true, runtime?: ManagedHookRuntime): Record<string, string> {
  return {
    AGENTMUX_HOOK_LAUNCH_SCOPED: scoped && carrierReady ? '1' : '0',
    AGENTMUX_HOOK_NODE: runtime?.nodePath ?? '',
    AGENTMUX_HOOK_RUNNER: runtime?.runnerPath ?? ''
  }
}

/**
 * Bracketed-paste 的字节判定住在 `../bracketed-paste.js`——一个不 import 任何 `node:` 内置的叶子模块。
 *
 * 本模块还依赖安装器与原生配置读取，渲染进程不直接消费；终端粘贴路径
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
 * `timeout`/`timeoutSec` 这两个属性位上再没有裸数字，且返回值由同一个导出常量按原生单位换算。
 * Provider 显式声明毫秒单位；未声明时使用秒。类型检查器解析原符号，避免再抄一份预算。
 */
export function hookCommandTimeout(providerId: ProviderWithHookCommandTimeout, unit: 'seconds' | 'milliseconds' = 'seconds'): Record<string, number> {
  return { [HOOK_COMMAND_TIMEOUT_FIELD[providerId]]: unit === 'milliseconds' ? HOOK_COMMAND_TIMEOUT_SECONDS * 1_000 : HOOK_COMMAND_TIMEOUT_SECONDS }
}

/** The Provider declares its actual native key; the shared reader owns bounded file access. */
export async function inspectHookDisableSetting(
  context: AgentProviderHookActivationContext,
  nativeKey: string
): Promise<AgentProviderHookActivation> {
  const target = context.plan.mutations[0]
  if (!target) throw new Error('The managed Hook plan is empty.')
  const file = await readManagedHookTarget(target.path)
  if (!file) return { active: false, code: 'HOOK_CONFIGURATION_CHANGED', action: 'The Hook configuration changed during inspection. Inspect this scope again.' }
  const config = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.content)) as Record<string, unknown>
  if (Object.hasOwn(config, nativeKey) && typeof config[nativeKey] !== 'boolean') {
    throw new AgentMuxError('Native Hook disable setting is not a boolean.', 'HOOK_TARGET_UNPARSEABLE')
  }
  if (config[nativeKey] === true) return { active: false, code: 'HOOK_CONFIGURATION_DISABLED',
    action: 'Managed Hooks are present but disabled in this configuration. Review the Provider setting, then inspect again.' }
  return { active: true, code: 'MANAGED_HOOK_CURRENT', action: null }
}
