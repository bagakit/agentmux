import { BROWSER_PAGE_MUTATING_CAPABILITY_NAMES, type AgentMuxControlBrowserRunOutcome } from '@agentmux/core'
import type { BrowserOperationPhase } from '../shared/browser-operation.js'
import type { BrowserScriptFailure } from './browser-script-runner.js'

/**
 * 执行器的失败 → 契约的结局四分类。
 *
 * 两边不是同一组分类，所以必须有这一层翻译而不能直接透传：
 *   - `script-error` → `script-failed`：你的程序错了，去改程序。
 *   - `timeout` / `output-limit` → `stopped`：程序没错，是**我们**主动截断的（跑太久 / 打太多）。
 *     这两支在执行器那边分开是对的（一个改逻辑、一个改日志量），但对调用方是同一件事：
 *     "没让它跑完"。区别写进 message，不占一个结局档位。
 *   - `crashed` → `indeterminate`：进程非正常终止，**做到哪一步不知道**。
 *   - `result-unavailable` → `indeterminate`：动作可能已完成，但结果未保全，不能自动重跑。
 *
 * 最后那一条是这层的全部理由。`crashed` 报成一次普通失败，调用方会重试——而页面上可能已经点过
 * 一次了。"分不清"必须是一等结局（AGENTS.md:32-52），它对调用方的含义是「先去看一眼页面，别重试」。
 *
 * 写成 `Record<kind, …>` 而不是 switch：执行器往失败联合里加一支时，这张表少一格是 TS2741，
 * 而不是安静落进某个 default 被当成 indeterminate。
 */
const OUTCOME_BY_FAILURE: Record<
  BrowserScriptFailure['kind'],
  (failure: BrowserScriptFailure) => AgentMuxControlBrowserRunOutcome
> = {
  'script-error': (failure) => ({
    kind: 'script-failed',
    message: failure.kind === 'script-error' && failure.stack ? failure.stack : describe(failure)
  }),
  timeout: (failure) => ({ kind: 'stopped', message: describe(failure) }),
  'output-limit': (failure) => ({ kind: 'stopped', message: describe(failure) }),
  'result-unavailable': (failure) => ({ kind: 'indeterminate', message: describe(failure) }),
  crashed: (failure) => ({ kind: 'indeterminate', message: describe(failure) })
}

/** 每一支自己那句人话。消息要说清**下一步该干什么**，而不只是复述发生了什么。 */
function describe(failure: BrowserScriptFailure): string {
  if (failure.kind === 'script-error') return failure.message
  if (failure.kind === 'timeout') {
    return `The script did not finish within ${failure.timeoutMs}ms and was stopped.`
  }
  if (failure.kind === 'output-limit') {
    return `The script was stopped after printing ${failure.capturedChars} characters. Log less.`
  }
  if (failure.kind === 'result-unavailable') {
    return `${failure.message} Actions may already have been executed. Do not automatically rerun the script; inspect the page and recover the original result if available.`
  }
  return `${failure.reason} The page may have been partially changed — check it before running anything again.`
}

/**
 * What the run had done when it ended: the page calls Main recorded, in order. Only the method and
 * status are read, so no page data or arguments reach the message.
 */
export type BrowserRunProgress = readonly { method: string; status: 'running' | 'completed' | 'failed' | 'stopped' }[]

/**
 * A stopped program says where it stopped. When the budget ends with a page-changing call still in
 * flight, that call may have taken effect, so the outcome is indeterminate (look before rerunning),
 * not stopped (which reads as "nothing happened, safe to run again").
 */
export function browserRunOutcomeFromFailure(
  failure: BrowserScriptFailure,
  progress: BrowserRunProgress = []
): AgentMuxControlBrowserRunOutcome {
  // Core's capability table owns which page calls act or navigate; every caller reads the same answer.
  const changesPage = (method: string) => BROWSER_PAGE_MUTATING_CAPABILITY_NAMES.has(method)
  const outcome = OUTCOME_BY_FAILURE[failure.kind](failure)
  if (failure.kind !== 'timeout') return outcome
  const done = progress.filter(step => step.status === 'completed').length
  const running = progress.filter(step => step.status === 'running')
  const where = running.length
    ? ` It was in ${running.map(step => step.method + '()').join(', ')} after ${done} completed page call${done === 1 ? '' : 's'}.`
    : ` ${done} page call${done === 1 ? '' : 's'} had completed; it was running your own code, not waiting on the page.`
  if (running.some(step => changesPage(step.method))) {
    return { kind: 'indeterminate', message: `${describe(failure)}${where} That call may have changed the page. Take a snapshot to see the page before running anything again; do not rerun the same program.` }
  }
  return { kind: 'stopped', message: `${describe(failure)}${where} Earlier calls stand. Split long work into shorter programs, or wait on one condition with its own timeout.` }
}

/**
 * 结局 → journal 的 phase。**Agent 收到的那句话和人在历史里看到的那句话必须是同一个结论。**
 *
 * 这张表存在的全部理由是 `indeterminate`：它两边同名，却曾经被写成 `kind === 'stopped' ?
 * 'stopped' : 'failed'` 折进 `failed`。于是一次子进程崩溃，收据对 Agent 说"做到哪一步不知道，
 * 先看页面、别重试"，历史对人说"失败了，改完重跑"——两个人按相反的结论行动，而页面上可能
 * 已经点过一次了。
 *
 * 同样写成 `Record<kind, …>` 而不是三元/switch：契约往结局联合里加一支时，这张表少一格是
 * TS2741，而不是安静落进 `failed`——那正是这条修补要拦住的那类遗漏。
 */
const PHASE_BY_OUTCOME: Record<AgentMuxControlBrowserRunOutcome['kind'], BrowserOperationPhase> = {
  completed: 'completed',
  'script-failed': 'failed',
  stopped: 'stopped',
  indeterminate: 'indeterminate'
}

export function browserOperationPhaseFromOutcome(
  kind: AgentMuxControlBrowserRunOutcome['kind']
): BrowserOperationPhase {
  return PHASE_BY_OUTCOME[kind]
}
