import type { AppConfig, ComposerShortcut, GoalsCommonActionRef, GoalsCommonActionsConfig } from '../../../shared/contracts'
import { resolveComposerShortcuts } from '../../../shared/composer-shortcut-library'
import { configuredExecutors, type ConfiguredExecutor } from './executors'
import { GOAL_EXPLORATION_ACTIONS, goalExplorationNextText, type GoalExplorationProject } from './goals-entry-actions'

export const DEFAULT_GOALS_COMMON_ACTIONS: GoalsCommonActionsConfig = {
  items: [{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }], collapsed: false
}
export const commonActionKey = (ref: GoalsCommonActionRef): string => `${ref.kind}:${ref.id}`
export const commonActionsDirectory = (config: AppConfig | null): GoalsCommonActionsConfig => config?.goalsCommonActions ?? DEFAULT_GOALS_COMMON_ACTIONS
export type GoalsCommonAction = {
  ref: GoalsCommonActionRef; key: string; body: string; label: string
  executor?: ConfiguredExecutor | undefined; project?: GoalExplorationProject; reason?: string; conditional?: boolean
}

/** Resolve live library bytes and the exact configured target; never store another prompt body. */
export function resolveGoalsCommonAction(ref: GoalsCommonActionRef, config: AppConfig | null, project: GoalExplorationProject | null): GoalsCommonAction {
  const executors = configuredExecutors(config)
  const key = commonActionKey(ref)
  if (ref.kind === 'builtin') {
    if (ref.id === 'next') return { ref, key, label: '项目的下一步', body: project ? goalExplorationNextText(project) : '根据项目情况，建议我下一步应该做什么', executor: executors[0], ...(project ? { project } : { conditional: true, reason: '打开过项目后显示' }) }
    const action = GOAL_EXPLORATION_ACTIONS.find(action => action.id === ref.id)!
    return { ref, key, body: action.text, label: ref.id === 'understand' ? '了解我并给我建议' : '尝试一个项目', executor: executors[0] }
  }
  const prompt = resolveComposerShortcuts(config).find(prompt => prompt.id === ref.id)
  if (!prompt) return { ref, key, label: '指令已删除', body: '', reason: '原指令已从指令库删除，可以移出常用操作。' }
  const executor = prompt.providerId ? executors.find(executor => executor.providerId === prompt.providerId) : executors[0]
  return { ref, key, label: prompt.label, body: prompt.body, executor,
    ...(prompt.providerId && !executor ? { reason: `没有配置适用 ${prompt.providerId} 的 Agent，请到设置中添加。` } : {}) }
}

/** Only the body is required by this entry; helper fields meet the original library contract. */
export function createCommonActionPrompt(body: string, prompts: readonly ComposerShortcut[], id = `prompt-${crypto.randomUUID()}`): ComposerShortcut {
  const used = new Set(prompts.map(prompt => prompt.keyword))
  const base = `action-${id.replace(/^prompt-/, '').slice(0, 8)}`
  let keyword = base, suffix = 2
  while (used.has(keyword)) keyword = `${base}-${suffix++}`
  return { id, keyword, label: body.trim().split('\n').find(line => line.trim())?.slice(0, 48) || '新操作', body }
}
