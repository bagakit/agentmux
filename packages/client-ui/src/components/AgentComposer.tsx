import type { ComposerInsertionHandle, ComposerPasteImage, ComposerDropFiles } from '../lib/composer-insertion.js'
import { type ReactNode, type Ref } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { matchComposerShortcut } from '../lib/composer-keyboard.js'
import { ComposerCompletionEditor, type ComposerCompletionProps } from './ComposerCompletionEditor.js'
export type { ComposerSuggestion } from '../lib/composer-completion.js'
import { ComposerReferenceTool } from './ComposerReferenceTool.js'
import type { ReadPastedImage } from './ConversationImage.js'
import type { ComposerSemanticReference } from '../lib/composer-semantic-reference.js'

export type AgentComposerProps = ComposerCompletionProps & {
  surfaceRef?: Ref<HTMLDivElement>
  active?: boolean
  value: string
  /** The host may own selected content that becomes text when explicitly submitted. */
  hasPendingContent?: boolean
  readPastedImage?: ReadPastedImage
  disabled: boolean
  placeholder: string
  activeFile?: string
  contextUsage?: ReactNode
  mailbox?: ReactNode
  aboveInput?: ReactNode
  identity?: ReactNode
  onActivateSemanticReference?: (reference: ComposerSemanticReference) => void
  tools?: ReactNode | ((references: ReactNode) => ReactNode)
  // Which action the primary button performs. `stop` while a turn is in flight, `send` otherwise. This is
  // a SEPARATE question from whether Enter submits: a working Agent shows Stop yet still takes a steer, so
  // this must not gate the Enter handler — that was the bug where one `isWorking` flag did both jobs.
  primaryAction?: 'send' | 'stop'
  feedback?: ReactNode
  postureTool?: ReactNode
  // The adapter atomically updates its draft and navigation. Non-null means handled; the shell
  // must not call the ordinary edit callback again, which would exit that navigation.
  historyNavigation?: 'browsing' | 'restored'
  onHistoryRecall?: (direction: 'older' | 'newer', draft: string, caret: number) => string | null
  onChange(value: string): void
  onSubmit?: () => void
  onQueue?: () => void
  onInterrupt?: () => void
  onReferenceActiveFile?: () => void
  onAttach?: () => void
  onPasteImage?: ComposerPasteImage
  onDropFiles?: ComposerDropFiles
  insertionRef?: Ref<ComposerInsertionHandle>
}

export function AgentComposer({
  surfaceRef,
  active = true,
  value,
  hasPendingContent = false,
  readPastedImage,
  disabled,
  placeholder,
  activeFile,
  tools,
  contextUsage,
  mailbox,
  aboveInput,
  identity,
  onActivateSemanticReference,
  commands = [],
  skills = [],
  references = [],
  onSelectSuggestion,
  completionConfig,
  onCompletionQuery,
  completionFeedback,
  primaryAction = 'send',
  feedback,
  postureTool,
  onChange,
  onSubmit,
  onQueue,
  onInterrupt,
  onReferenceActiveFile,
  onAttach,
  onPasteImage,
  onDropFiles,
  insertionRef,
  onHistoryRecall,
  historyNavigation,
  promptKeywords = []
}: AgentComposerProps) {
  const hasContent = Boolean(value.trim()) || hasPendingContent
  const canSubmit = !disabled && Boolean(onSubmit) && hasContent
  const referenceTools = <>
          <ComposerReferenceTool disabled={disabled} onSelect={onAttach}
            label="Reference files for the Agent to read" />
          {/* A shortcut to the file already open, not a second way to attach — so it appears only
              when there is one, rather than sitting permanently greyed out. */}
          {activeFile && onReferenceActiveFile ? (
            <button
              type="button"
              className="composer-tool"
              disabled={disabled}
              onClick={onReferenceActiveFile}
              aria-label={`Reference ${activeFile}`} title={`Reference ${activeFile}`}
            >
              <SemanticIcon name="action.mention" size={14} /> <span className="composer-tool__label">{activeFile.split('/').at(-1)}</span>
            </button>
          ) : null}
  </>
  return (
    <>
    {aboveInput}
    <div ref={surfaceRef} className="composer" data-agent-composer="true">
      {/* The maintained editor owns composition, selection and undo; the host owns the draft. */}
      <ComposerCompletionEditor
        active={active}
        aria-label="Message Agent"
        {...(insertionRef ? { insertionRef } : {})}
        disabled={disabled}
        value={value}
        {...(historyNavigation ? { historyNavigation } : {})}
        onValueChange={onChange}
        commands={commands} skills={skills} references={references} promptKeywords={promptKeywords}
        {...(completionConfig ? { completionConfig } : {})}
        {...(onCompletionQuery ? { onCompletionQuery } : {})}
        {...(completionFeedback ? { completionFeedback } : {})}
        {...(onSelectSuggestion ? { onSelectSuggestion } : {})}
        onKeyDown={(event, caret, selectionEmpty, suggestionsOpen) => {
          // No !isWorking guard: a running Agent can be steered. Enter submits whenever the surface allows
          // a submit and there is text; delivery (and codex's mid-turn refusal) is Core's call, not the
          // renderer's. Stop stays a click on the button, so mid-turn Enter never risks an accidental stop.
          // IME candidate confirmation also arrives as Enter. Let the IME commit first; otherwise the
          // composer submits the pre-conversion draft and the user sees missing/replaced characters in
          // the Agent conversation (#609). 判据必须走 SSOT 的四路谓词：此前这里手抄了两路
          // (`nativeEvent?.isComposing || keyCode === 229`)，漏掉顶层 `isComposing` 与
          // `nativeEvent.keyCode`。只标记那两路的输入法照旧会把半转换草稿提交上去。
          // Candidates retain their own scope after moving focus out of the editor.
          const shortcut = matchComposerShortcut(event)
          if ((shortcut === 'message-tool.previous' || shortcut === 'message-tool.next') && selectionEmpty &&
            !suggestionsOpen && onHistoryRecall) {
            if (onHistoryRecall(shortcut === 'message-tool.previous' ? 'older' : 'newer', value, caret) !== null) event.preventDefault()
            return
          }
          // 两个 Enter 意图，绝不能互相退化（interaction SSOT「Cmd+Enter 直接 steer」）：
          // Bare Enter follows the parent's queue intent, including a pending interaction. Stop is
          // a separate action and must not decide whether a waiting/blocked Agent can retain a draft.
          // Cmd/Ctrl+Enter follows immediate submission when available; Shift+Enter and IME stay editing.
          if (shortcut === 'message-tool.send' && onQueue && hasContent) {
            event.preventDefault()
            onQueue()
            return
          }
          if ((shortcut === 'message-tool.send' || shortcut === 'message-tool.send-immediately') && canSubmit) {
            event.preventDefault()
            onSubmit?.()
          }
        }}
        {...(readPastedImage ? { readPastedImage } : {})}
        {...(onPasteImage ? { onPasteImage } : {})}
        {...(onDropFiles ? { onDropFiles } : {})}
        {...(onActivateSemanticReference ? { onActivateReference: onActivateSemanticReference } : {})}
        placeholder={placeholder}
      />
      <div className="composer__toolbar">
        <div onFocusCapture={(event) => {
          // Keep keyboard focus inside this scroll strip without moving the editor or terminal.
          const strip = event.currentTarget
          if (strip.contains(event.target)) {
            const viewport = strip.getBoundingClientRect(), focused = event.target.getBoundingClientRect()
            if (focused.left < viewport.left) strip.scrollLeft += focused.left - viewport.left
            else if (focused.right > viewport.right) strip.scrollLeft += focused.right - viewport.right
          }
        }}>
          {typeof tools === 'function' ? tools(referenceTools) : <>{tools}{referenceTools}</>}
          {/* Absence hides: only a Provider that declared an addressable posture control renders this,
              and only while the composer can write to the live process. */}
          {postureTool}
        </div>
        <div>
          <div className="composer-session-controls" role="group" aria-label="Session controls">
            {contextUsage}
            <button
              type="button"
              className={`composer-send${primaryAction === 'stop' ? ' composer-send--working' : ''}`}
              disabled={primaryAction === 'stop' ? disabled || !onInterrupt : !canSubmit}
              onClick={primaryAction === 'stop' ? onInterrupt : onSubmit}
              aria-label={primaryAction === 'stop' ? 'Interrupt the current turn' : 'Send'}
              title={primaryAction === 'stop' ? 'Interrupt the current reply — keep this session' : 'Send'}
            >
              {primaryAction === 'stop'
                ? <SemanticIcon name="action.stop" size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                : <SemanticIcon name="action.submit" size={15} aria-hidden="true" />}
            </button>
            {mailbox}
            {identity}
          </div>
        </div>
      </div>
      {feedback}
    </div>
    </>
  )
}
