import { existsSync } from 'node:fs'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { resolveCoreBinPath } from '../runtime-paths.js'
import type { AgentCatalogEntry, AgentProviderId } from '../types.js'

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

export const BRACKETED_PASTE_START = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'

export function sanitizeBracketedPasteText(text: string): string {
  return text.replaceAll('\u001b', '\u241b')
}

export function wrapBracketedPasteText(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(text)}${BRACKETED_PASTE_END}`
}

export function buildPromptInputPayload(prompt: string): string {
  return /[\r\n]/.test(prompt)
    ? wrapBracketedPasteText(prompt)
    : sanitizeBracketedPasteText(prompt)
}

/**
 * 受管 Hook 命令的执行超时（秒）。每个 Provider 的 hook 配置都要给它写超时，值统一为这个常量。
 *
 * 之所以集中：这个值曾在八九个 provider 文件里各手抄一份 `10`，其中 copilot 还用的是**另一个字段名**
 * （`timeoutSec`，见该文件头——这个 CLI 的键带单位后缀）。字段名的分歧是**每个 CLI 的正当差异**，
 * 保留；漂移的只是那个值——改一处、漏改别处，各 Provider 的 hook 就悄悄用上不同超时，且没有编译错误。
 * 集中到这里后，`providers/` 下再出现裸的数字 `timeout`/`timeoutSec` 就是新的手抄，由
 * test/provider-hook-timeout-source.test.ts 那道结构守卫抓（行为等价挡不住新抄一份 `10`）。
 */
export const HOOK_COMMAND_TIMEOUT_SECONDS = 10