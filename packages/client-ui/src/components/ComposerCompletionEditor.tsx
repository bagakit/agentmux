import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DismissableLayer } from '@radix-ui/react-dismissable-layer'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useClientUiPlatform } from '../platform.js'
import { InlineComposer, type InlineComposerProps } from './InlineComposer.js'
import type { ComposerInsertionHandle } from '../lib/composer-insertion.js'
import { resolveComposerInputConfig, type ComposerInputConfig } from '../lib/composer-input-config.js'
import { completionAtCaret, hasExplicitComposerTrigger, matchingComposerSuggestions, type ComposerCaret, type ComposerCompletionQuery, type ComposerSuggestion, type ComposerSuggestionKind } from '../lib/composer-completion.js'
import { composerKeywordAtCaret } from '../lib/composer-keywords.js'
import { matchComposerShortcut } from '../lib/composer-keyboard.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'
import { composerChoiceReadingProps } from '../lib/composer-choice-reading.js'
import { useModalOverlayContainer } from './Modal.js'

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
  const overlayContainer = useModalOverlayContainer(platform.overlayContainer())
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
    const anchor = shell.current?.closest<HTMLElement>('.composer') ?? shell.current, floating = panel.current
    if (!open || !anchor || !floating) return
    let current = true
    const update = async () => {
      const result = await computePosition(anchor, floating, { strategy: 'fixed', placement: 'top-start',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableHeight, availableWidth, rects }) {
          floating.style.setProperty('--composer-completion-available-height', `${Math.max(0, availableHeight)}px`)
          Object.assign(floating.style, { maxWidth: `${Math.max(0, availableWidth)}px`, width: `${Math.min(560, rects.reference.width, Math.max(0, availableWidth))}px` })
        } })] })
      if (current) Object.assign(floating.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, floating, () => { void update() })
    return () => { current = false; stop() }
  }, [open, platform.ownerDocument, overlayContainer])
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
    const horizontalKey = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    if (shortcut !== 'message-tool.next' && shortcut !== 'message-tool.previous' && shortcut !== 'message-tool.send' && !horizontalKey) return false
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    if (!buttons.length) return false
    const current = buttons.indexOf(panel.current?.ownerDocument.activeElement as HTMLButtonElement)
    const horizontal = current >= 0 && horizontalKey
    if (horizontalKey && !horizontal) return false
    if (shortcut === 'message-tool.send') {
      if (current < 0) return false
      event.preventDefault(); buttons[current]!.click(); return true
    }
    event.preventDefault()
    const forward = horizontal ? event.key === 'ArrowRight' : shortcut === 'message-tool.next'
    let next = current < 0 ? (forward ? 0 : buttons.length - 1)
      : (current + (forward ? 1 : -1) + buttons.length) % buttons.length
    if (current >= 0 && !horizontal) {
      // Follow rendered rows across groups; CSS alone owns the column count.
      const rects = buttons.map(button => button.getBoundingClientRect()), origin = rects[current]!
      const rows = rects.map((rect, index) => ({ rect, index })).filter(({ rect }) =>
        forward ? rect.top > origin.top + 1 : rect.top < origin.top - 1)
      if (rows.length) {
        const row = forward ? Math.min(...rows.map(({ rect }) => rect.top)) : Math.max(...rows.map(({ rect }) => rect.top))
        const column = origin.left + origin.width / 2
        next = rows.filter(({ rect }) => Math.abs(rect.top - row) < 1)
          .sort((a, b) => Math.abs(a.rect.left + a.rect.width / 2 - column) - Math.abs(b.rect.left + b.rect.width / 2 - column))[0]!.index
      } else if (origin.height > 0) next = current
    }
    buttons[next]!.focus({ preventScroll: true })
    const list = panel.current?.querySelector<HTMLElement>('.composer__suggestions')
    if (list) {
      const bounds = list.getBoundingClientRect(), target = buttons[next]!.getBoundingClientRect()
      const heading = buttons[next]!.closest('.composer__suggestion-group')?.querySelector('h4')?.getBoundingClientRect().height ?? 0
      if (target.top < bounds.top + heading) list.scrollTop += target.top - bounds.top - heading
      else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom
    }
    return true
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
    {open && overlayContainer ? createPortal(<DismissableLayer asChild
      onFocusOutside={event => event.preventDefault()}
      onPointerDownOutside={event => { if (shell.current?.contains(event.target as Node)) event.preventDefault() }}
      onEscapeKeyDown={event => { event.preventDefault(); if (!isImeOwnedKeyboardEvent(event)) { setDismissed(queryKey); focusEditor() } }}
      onDismiss={() => setDismissed(queryKey)}><div ref={panel} className="composer-completion-popover" style={{ position: 'fixed', visibility: 'hidden' }}>
    {suggestions.length ? <div className="composer__suggestions" role="listbox" aria-label={`Agent ${range!.kind}`} onKeyDown={suggestionKeyDown}>
      {[...groups].map(([group, items]) => {
        const options = items.map((item, index) => <button type="button" role="option" aria-selected="false" key={item.id ?? `${group}:${index}:${item.text}`} {...composerChoiceReadingProps(`${item.label ?? item.text}\n${item.description}`)}
          onClick={() => choose(item)}>{item.icon ? <span className="composer__suggestion-icon">{item.icon}</span> : null}
          <span className="composer__suggestion-label" data-choice-reading=""><span>{item.label ?? item.text}</span></span><small data-choice-reading=""><span>{item.description}</span></small></button>)
        const label = group || ({ command: 'Commands', skill: 'Skills', reference: 'Agents & files', keyword: 'Prompts' }[range!.kind])
        return <div className="composer__suggestion-group" role="group" aria-label={label} key={group}>{groups.size > 1 ? <h4>{label}<span>{items.length}</span></h4> : null}{options}</div>
      })}
    </div> : null}
    {completionFeedback ? <div className="composer__suggestion-feedback" role="status">{completionFeedback}</div> : null}
    </div></DismissableLayer>, overlayContainer) : null}
  </div>
}
