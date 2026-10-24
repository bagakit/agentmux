import type { ComposerSuggestion } from '../components/AgentComposer.js'
import { encodeSemanticReference } from './composer-semantic-reference.js'

/** The presentation fields of the original Settings Prompt; clients never own a second library. */
export type ComposerPrompt = { id: string; keyword: string; label: string; body: string; providerId?: string }
export const SHORTCUT_GROUP_LABEL = 'Shortcuts'
export const AGENT_COMMAND_GROUP_LABEL = 'Agent commands'

export function composerShortcutsForProvider<T extends ComposerPrompt>(prompts: readonly T[], providerId: string | undefined): T[] {
  return prompts.filter(prompt => prompt.providerId === undefined || prompt.providerId === providerId)
}

/** Desktop and Mobile insert the same semantic body, including when a native command has the same word. */
export function composerCommandCandidates<T extends ComposerPrompt>(prompts: readonly T[], providerId: string | undefined,
  commands: readonly { text: string; description: string }[]) {
  const shortcuts = composerShortcutsForProvider(prompts, providerId)
  const shortcutCandidates: ComposerSuggestion[] = shortcuts.map(shortcut => ({
    id: `shortcut:${shortcut.id}`, text: `/${shortcut.keyword}`, label: shortcut.label, group: SHORTCUT_GROUP_LABEL,
    description: `${shortcut.keyword} · Insert prompt`, searchText: `${shortcut.keyword} ${shortcut.label}`,
    insertText: encodeSemanticReference({ kind: 'subcommand', token: `/${shortcut.keyword}`, label: shortcut.label, reference: shortcut.body })
  }))
  return { shortcuts,
    commands: [...shortcutCandidates, ...commands.map(command => ({ ...command, id: `command:${command.text}`,
      label: command.text, group: AGENT_COMMAND_GROUP_LABEL, insertText: command.text }))],
    promptKeywords: shortcutCandidates.map((item, index) => ({ ...item, text: shortcuts[index]!.keyword, label: shortcuts[index]!.keyword })) }
}
