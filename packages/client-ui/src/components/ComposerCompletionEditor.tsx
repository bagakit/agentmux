import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useClientUiPlatform } from '../platform.js'
import { InlineComposer, type InlineComposerProps } from './InlineComposer.js'
import type { ComposerInsertionHandle } from '../lib/composer-insertion.js'
import { resolveComposerInputConfig, type ComposerInputConfig } from '../lib/composer-input-config.js'
import { completionAtCaret, hasExplicitComposerTrigger, matchingComposerSuggestions, type ComposerCaret, type ComposerCompletionQuery, type ComposerSuggestion, type ComposerSuggestionKind } from '../lib/composer-completion.js'
import { composerKeywordAtCaret } from '../lib/composer-keywords.js'
import { matchComposerShortcut } from '../lib/composer-keyboard.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'

export type ComposerCompletionProps = {
  completionConfig?: ComposerInputConfig
  commands?: ComposerSuggestion[]
  skills?: ComposerSuggestion[]
  references?: ComposerSuggestion[]
  promptKeywords?: ComposerSuggestion[]
  onCompletionQuery?: (query: ComposerCompletionQuery | null) => void
  completionFeedback?: ReactNode
  onSelectSuggestion?: (text: string, kind: ComposerSuggestionKind, selected: ComposerSuggestion) => string | void
}
export type ComposerCompletionEditorProps = Omit<InlineComposerProps, 'onKeyDown' | 'keywords'> & ComposerCompletionProps & {
  onKeyDown(event: KeyboardEvent, caret: number, selectionEmpty: boolean, suggestionsOpen: boolean): void
}

/** Shared editor completion; clients own discovery, the original editor owns selection and Undo. */
export function ComposerCompletionEditor({ completionConfig, commands = [], skills = [], references = [], promptKeywords = [],
  onCompletionQuery, completionFeedback, onSelectSuggestion, insertionRef, onKeyDown, onSelectionChange, ...editorProps }: ComposerCompletionEditorProps) {
  const platform = useClientUiPlatform()
  const config = resolveComposerInputConfig(completionConfig)
  const [caret, setCaret] = useState<ComposerCaret | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const shell = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const insertion = useRef<ComposerInsertionHandle | null>(null)
  const editorHandle = useCallback((handle: ComposerInsertionHandle | null) => {
    insertion.current = handle
    if (typeof insertionRef === 'function') insertionRef(handle)
    else if (insertionRef) insertionRef.current = handle
  }, [insertionRef])
  const range = completionAtCaret(caret, config)
  const source = range?.kind === 'command' ? commands : range?.kind === 'skill' ? skills : range?.kind === 'reference' ? references : promptKeywords
  const choices = range ? matchingComposerSuggestions(source, range) : []
  const queryKey = range ? `${range.kind}:${range.from}:${range.to}:${range.expected}` : ''
  const suggestions = !editorProps.disabled && editorProps.active !== false && dismissed !== queryKey ? choices : []
  const queryKind = !editorProps.disabled && editorProps.active !== false && range && (range.kind !== 'keyword' || choices.length) && dismissed !== queryKey ? range.kind : null
  const queryText = queryKind ? range!.query : ''
  const open = Boolean(queryKind && (suggestions.length || completionFeedback))
  useLayoutEffect(() => {
    const anchor = shell.current, floating = panel.current
    if (!open || !anchor || !floating) return
    let current = true
    const update = async () => {
      const result = await computePosition(anchor, floating, { strategy: 'fixed', placement: 'top-start',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableHeight, availableWidth, rects }) {
          Object.assign(floating.style, { maxHeight: `${Math.max(0, availableHeight)}px`, maxWidth: `${Math.max(0, availableWidth)}px`, width: `${Math.min(Math.max(rects.reference.width, 260), Math.max(0, availableWidth))}px` })
        } })] })
      if (current) Object.assign(floating.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, floating, () => { void update() })
    return () => { current = false; stop() }
  }, [open])
  useEffect(() => { onCompletionQuery?.(queryKind ? { kind: queryKind, query: queryText } : null) }, [onCompletionQuery, queryKind, queryText])
  function selectionChanged(next: ComposerCaret): void {
    setCaret(previous => previous && previous.from === next.from && previous.to === next.to && previous.before === next.before && previous.after === next.after && previous.composing === next.composing ? previous : next)
    onSelectionChange?.(next)
  }
  function focusEditor(): void { shell.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus() }
  function choose(item: ComposerSuggestion, targetRange = range): boolean {
    if (!targetRange) return false
    // `item` is the selected original object, even when names and labels are identical.
    const replacement = onSelectSuggestion?.(item.text, targetRange.kind, item) ?? item.insertText ?? item.text
    const suffix = item.keepOpen || /\s$/u.test(replacement) ? '' : ' '
    const replaced = insertion.current?.replaceRange?.(targetRange, replacement + suffix) ?? false
    if (replaced) { setDismissed(null); focusEditor() }
    return replaced
  }
  function suggestionKeyDown(event: KeyboardEvent | ReactKeyboardEvent): boolean {
    if (!open || isImeOwnedKeyboardEvent(event) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
    const shortcut = matchComposerShortcut(event)
    if (shortcut === 'message-tool.dismiss-suggestions') {
      event.preventDefault(); setDismissed(queryKey); focusEditor(); return true
    }
    if (shortcut !== 'message-tool.next' && shortcut !== 'message-tool.previous' && shortcut !== 'message-tool.send') return false
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    if (!buttons.length) return false
    const current = buttons.indexOf(panel.current?.ownerDocument.activeElement as HTMLButtonElement)
    if (shortcut === 'message-tool.send') {
      if (current < 0) return false
      event.preventDefault(); buttons[current]!.click(); return true
    }
    event.preventDefault()
    const next = current < 0 ? (shortcut === 'message-tool.next' ? 0 : buttons.length - 1)
      : (current + (shortcut === 'message-tool.next' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]!.focus(); return true
  }
  const groups = new Map<string, ComposerSuggestion[]>()
  for (const item of suggestions) {
    const key = item.group ?? ''
    const group = groups.get(key)
    if (group) group.push(item); else groups.set(key, [item])
  }
  return <div ref={shell} className="composer-completion-editor">
    <InlineComposer {...editorProps} completionConfig={config} insertionRef={editorHandle} onSelectionChange={selectionChanged}
      keywords={config.keywords ? promptKeywords.map(item => item.text) : []}
      onKeyDown={(event, position, empty) => {
        if (empty && suggestionKeyDown(event)) return
        if (empty && config.keywords && caret && !caret.composing && matchComposerShortcut(event) === 'message-tool.expand-prompt' && !hasExplicitComposerTrigger(caret.before, caret.before.length, config)) {
          const keyword = composerKeywordAtCaret(caret.before + (caret.after ?? ''), caret.before.length, promptKeywords.map(item => item.text))
          const original = promptKeywords.find(item => item.text === keyword)
          const keywordRange = keyword ? { kind: 'keyword' as const, query: keyword, expected: keyword, from: caret.from - keyword.length, to: caret.to } : null
          if (original && choose(original, keywordRange)) { event.preventDefault(); return }
        }
        onKeyDown(event, position, empty, suggestions.length > 0)
      }} />
    {open ? createPortal(<div ref={panel} className="composer-completion-popover" style={{ position: 'fixed', visibility: 'hidden' }}>
    {suggestions.length ? <div className="composer__suggestions" role="listbox" aria-label={`Agent ${range!.kind}`} onKeyDown={suggestionKeyDown}>
      {[...groups].map(([group, items]) => {
        const options = items.map((item, index) => <button type="button" role="option" aria-selected="false" key={item.id ?? `${group}:${index}:${item.text}`}
          onClick={() => choose(item)}>{item.icon ? <span className="composer__suggestion-icon">{item.icon}</span> : null}
          <span className="composer__suggestion-label">{item.label ?? item.text}</span><small>{item.description}</small></button>)
        return group && groups.size > 1 ? <div className="composer__suggestion-group" role="group" aria-label={group} key={group}><h4>{group}</h4>{options}</div> : options
      })}
    </div> : null}
    {completionFeedback ? <div className="composer__suggestion-feedback" role="status">{completionFeedback}</div> : null}
    </div>, platform.overlayContainer()) : null}
  </div>
}
