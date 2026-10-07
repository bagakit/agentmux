import type { ReactNode } from 'react'
import type { ComposerInputConfig } from './composer-input-config.js'

export type ComposerSuggestionKind = 'command' | 'skill' | 'reference' | 'keyword'
export type ComposerSuggestion = {
  text: string
  description: string
  group?: string
  id?: string
  label?: string
  searchText?: string
  insertText?: string
  icon?: ReactNode
  /** A directory continues the same query rather than terminating it with a space. */
  keepOpen?: boolean
}
export type ComposerCompletionQuery = { kind: ComposerSuggestionKind; query: string }
export type ComposerCaret = { before: string; after?: string; from: number; to: number; composing: boolean }
export type ComposerCompletionRange = ComposerCompletionQuery & { from: number; to: number; expected: string }

export function composerWordBefore(text: string, caret = text.length): string {
  let from = caret
  while (from > 0 && !/[\s\ufffc]/u.test(text[from - 1]!)) from--
  return text.slice(from, caret)
}

/** The configured explicit grammar takes priority over bare Prompt keyword expansion. */
export function hasExplicitComposerTrigger(text: string, caret: number, config: ComposerInputConfig): boolean {
  const word = composerWordBefore(text, caret)
  return [config.command, config.skill, config.reference].some(prefix => prefix !== null && word.startsWith(prefix))
}

/** Only the editor's current, collapsed selection can name a completion range. */
export function completionAtCaret(caret: ComposerCaret | null, config: ComposerInputConfig): ComposerCompletionRange | null {
  if (!caret || caret.composing || caret.from !== caret.to) return null
  const word = composerWordBefore(caret.before)
  for (const kind of ['command', 'skill', 'reference'] as const) {
    const prefix = config[kind]
    if (prefix && word.startsWith(prefix)) return { kind, query: word.slice(prefix.length), from: caret.from - word.length, to: caret.to, expected: word }
  }
  if (config.keywords && /^[A-Za-z0-9_-]{2,}$/u.test(word)) return { kind: 'keyword', query: word, from: caret.from - word.length, to: caret.to, expected: word }
  return null
}

export function matchingComposerSuggestions(source: readonly ComposerSuggestion[], range: ComposerCompletionQuery): ComposerSuggestion[] {
  const query = range.query.toLocaleLowerCase()
  return source.filter(item => range.kind === 'keyword'
    ? item.text.startsWith(range.query)
    : (item.searchText ?? `${item.text.replace(/^[/$@]/u, '')} ${item.label ?? ''}`).toLocaleLowerCase().includes(query))
}
