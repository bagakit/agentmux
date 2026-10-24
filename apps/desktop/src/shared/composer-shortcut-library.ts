import { SHORTCUT_GROUP_LABEL } from '@agentmux/client-ui/composer-command-candidates'
import type { ComposerShortcut } from './contracts'
import type { AgentDisplayState } from '@agentmux/core'

/** The display states a user can bind to the same durable Prompt resource. */
export const COMPOSER_PROMPT_STATES = [
  'starting', 'running', 'disconnected', 'working', 'waiting', 'blocked', 'done', 'exited', 'error'
] as const satisfies readonly AgentDisplayState[]

/**
 * 缺席时返回的那一份空列表——**共享冻结**的同一个引用，不是每次新建一个 `[]`。
 *
 * 这一条是承重的：取值层被放在 zustand 选择器里（`useAppStore((state) => resolveComposerShortcuts(...))`），
 * 而 zustand 按引用比较。就地 `?? []` 每次调用都是新引用，于是选择器永远"变了"，组件无限重渲染。
 * 更坏的是它只在**没有这个字段**的配置上炸——默认配置带着两条，所以开发时一路正常。
 */
const NO_PROMPTS: readonly ComposerShortcut[] = Object.freeze([])

/**
 * 本地 prompt 库的取值层。
 *
 * 为什么是函数而不是各处 `config.composerShortcuts ?? []`：这两个默认（缺席即空、缺 providerId 即
 * 通用）会被三方问到——Composer 的候选、裸词识别、设置页——而分居各处的同一个默认必然漂移。
 * 本仓 `resolveNotificationModeId` 是同一形状的先例，理由也一样。
 *
 * 缺席解析成空列表且**不回写盘**：空与缺席语义完全一样。更要紧的是内置那两条是
 * `DEFAULT_CONFIG` 里的默认项，用户删光后配置里就是空列表——任何「缺席即补默认」的回填都会把
 * 删掉的东西送回来。
 */
export function resolveComposerShortcuts(
  config: { composerShortcuts?: ComposerShortcut[] | undefined } | null | undefined
): readonly ComposerShortcut[] {
  return config?.composerShortcuts ?? NO_PROMPTS
}

export function composerShortcutSuggestion(
  shortcut: ComposerShortcut
): { text: string; description: string; group: string } {
  return {
    text: `/${shortcut.keyword}`,
    description: shortcut.label,
    group: SHORTCUT_GROUP_LABEL
  }
}

/** 光标前的裸词若命中某条 prompt 的 keyword，返回那一条。命中判定是**整词相等**，不是前缀。 */
export function composerShortcutForBareWord(
  prompts: readonly ComposerShortcut[],
  word: string
): ComposerShortcut | undefined {
  return prompts.find((prompt) => prompt.keyword === word)
}
