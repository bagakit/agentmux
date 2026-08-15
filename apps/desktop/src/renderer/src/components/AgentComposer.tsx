import type { ReactNode } from 'react'
import { useId } from 'react'
import { AtSign, ArrowUp, ChevronDown, MessageSquare, Paperclip, Square } from 'lucide-react'
import type { AgentPostureControl } from '@agentmux/core'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { PosturePicker } from './PosturePicker'
import { ComposerTextarea } from './ComposerTextarea'

export type AgentComposerProps = {
  value: string
  disabled: boolean
  placeholder: string
  activeFile?: string
  contextUsage?: ReactNode
  // The queued prompts themselves, not a count. A bare number reads as a bug — you cannot tell a real
  // pending queue from a stuck counter without seeing what is in it. Count is derived (`.length`), so
  // the badge and the list can never disagree.
  queued?: readonly string[]
  // Whether the queue can still drain. The store's flush requires `processState === 'running'`
  // (store.ts flushAgentSteerQueue), so once the run exits the entries stay put forever — but the badge
  // went on promising "queued for delivery" over them, which is the one thing that can no longer happen.
  // A pending interaction is NOT this case: that flush also early-returns, yet `respondInteraction`
  // re-flushes the moment the user answers, so those really are still on their way. The distinction is
  // "will this ever drain" and it does not line up with `canSubmit` — hence its own prop rather than
  // reusing the submit axis.
  queueDeliverable?: boolean
  tools?: ReactNode
  commands?: Array<{ text: string; description: string }>
  skills?: Array<{ text: string; description: string }>
  references?: Array<{ text: string; description: string }>
  onSelectSuggestion?: (text: string, kind: 'command' | 'skill' | 'reference') => void
  // Which action the primary button performs. `stop` while a turn is in flight, `send` otherwise. This is
  // a SEPARATE question from whether Enter submits: a working Agent shows Stop yet still takes a steer, so
  // this must not gate the Enter handler — that was the bug where one `isWorking` flag did both jobs.
  primaryAction?: 'send' | 'stop'
  postureControl?: AgentPostureControl
  // Shell-style history recall on the up/down arrows. The shell owns the keys; the semantics (line
  // boundary + the recall reducer) live in the adapter so they stay unit-testable — this component cannot
  // run its own handlers under this repo's node-env vitest. Returns the value to place in the box, or null
  // to let the arrow fall through to normal caret movement. direction: 'older' = ArrowUp, 'newer' = ArrowDown.
  onHistoryRecall?: (direction: 'older' | 'newer', draft: string, caret: number) => string | null
  onChange(value: string): void
  onSubmit?: () => void
  onQueue?: () => void
  onInterrupt?: () => void
  onReferenceActiveFile?: () => void
  onAttach?: () => void
  onPasteImage?: (image: { bytes: Uint8Array; extension: string }) => void
  onSetPosture?: (modeId: string) => void
}

export function AgentComposer({
  value,
  disabled,
  placeholder,
  activeFile,
  tools,
  contextUsage,
  queued = [],
  queueDeliverable = true,
  commands = [],
  skills = [],
  references = [],
  onSelectSuggestion,
  primaryAction = 'send',
  postureControl,
  onChange,
  onSubmit,
  onQueue,
  onInterrupt,
  onReferenceActiveFile,
  onAttach,
  onPasteImage,
  onSetPosture,
  onHistoryRecall
}: AgentComposerProps) {
  const canSubmit = !disabled && Boolean(onSubmit) && Boolean(value.trim())

  const trigger = value.match(/(?:^|\s)([\/$@][^\s]*)$/)?.[1] ?? ''
  const suggestionKind = trigger.startsWith('/') ? 'command' : trigger.startsWith('$') ? 'skill' : trigger.startsWith('@') ? 'reference' : null
  const source = suggestionKind === 'command' ? commands : suggestionKind === 'skill' ? skills : suggestionKind === 'reference' ? references : []
  const suggestions = source.filter((item) => item.text.startsWith(trigger) && item.text !== trigger)
  return (
    <details open className="composer" data-agent-composer="true">
      {/* 受控 + 认识 IME 组字：为什么这一格不能是裸 <textarea>，见 ComposerTextarea 与
          lib/composer-composition.ts（#609）。 */}
      <ComposerTextarea
        aria-label="Message Agent"
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        onKeyDown={(event) => {
          // No !isWorking guard: a running Agent can be steered. Enter submits whenever the surface allows
          // a submit and there is text; delivery (and codex's mid-turn refusal) is Core's call, not the
          // renderer's. Stop stays a click on the button, so mid-turn Enter never risks an accidental stop.
          // IME candidate confirmation also arrives as Enter. Let the IME commit first; otherwise the
          // composer submits the pre-conversion draft and the user sees missing/replaced characters in
          // the Agent conversation (#609). 判据必须走 SSOT 的四路谓词：此前这里手抄了两路
          // (`nativeEvent?.isComposing || keyCode === 229`)，漏掉顶层 `isComposing` 与
          // `nativeEvent.keyCode`。只标记那两路的输入法照旧会把半转换草稿提交上去。
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length && !isImeCompositionKeyDown(event)) {
            event.preventDefault()
            const buttons = [...(event.currentTarget.closest('.composer')?.querySelectorAll<HTMLButtonElement>('.composer__suggestions button') ?? [])]
            const current = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
            const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length
            buttons[next]?.focus()
            return
          }
          if (event.key === 'Escape' && suggestions.length) {
            event.preventDefault()
            event.currentTarget.focus()
            return
          }
          // Shell-style history recall. Suggestions win the arrows (their block above returns first), so
          // this only runs with no open list. The adapter decides everything testable — line boundary and
          // the recall reducer — and returns the value to place, or null to let the arrow move the caret
          // normally (the multiline resolution: bare ArrowUp only recalls when the caret is on the first
          // line, ArrowDown only on the last line; otherwise the caret just moves). #609 IME guard applies.
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !suggestions.length && onHistoryRecall && !isImeCompositionKeyDown(event)) {
            const recalled = onHistoryRecall(event.key === 'ArrowUp' ? 'older' : 'newer', value, event.currentTarget.selectionStart)
            if (recalled !== null) {
              event.preventDefault()
              onChange(recalled)
            }
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !isImeCompositionKeyDown(event) && primaryAction === 'stop' && onQueue && value.trim()) {
            event.preventDefault()
            onQueue()
            return
          }
          if (event.key === 'Enter'  && !event.shiftKey && !isImeCompositionKeyDown(event) && canSubmit) {
            event.preventDefault()
            onSubmit?.()
          }
        }}
        onPaste={(event) => {
          if (disabled || !onPasteImage) return
          const file = [...event.clipboardData.items]
            .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
            ?.getAsFile()
          if (!file) return
          // Claim the paste before the textarea inserts the image's filename as text.
          event.preventDefault()
          const extension = file.type.slice('image/'.length).split('+')[0] ?? 'png'
          void file.arrayBuffer().then((buffer) => {
            onPasteImage({ bytes: new Uint8Array(buffer), extension })
          })
        }}
        placeholder={placeholder}
        rows={1}
      />
      <div className="composer__toolbar">
        <div>
          <button
            type="button"
            className="composer-tool"
            disabled={disabled || !onAttach}
            onClick={onAttach}
            title="Reference files for the Agent to read"
          >
            <Paperclip size={14} /> Files
          </button>
          {tools}
          {/* A shortcut to the file already open, not a second way to attach — so it appears only
              when there is one, rather than sitting permanently greyed out. */}
          {activeFile && onReferenceActiveFile ? (
            <button
              type="button"
              className="composer-tool"
              disabled={disabled}
              onClick={onReferenceActiveFile}
              title={`Reference ${activeFile}`}
            >
              <AtSign size={14} /> {activeFile.split('/').at(-1)}
            </button>
          ) : null}
          {/* Absence hides: only a Provider that declared an addressable posture control renders this,
              and only while the composer can write to the live process. */}
          {onSetPosture ? (
            <PosturePicker control={postureControl} disabled={disabled} onSet={onSetPosture} />
          ) : null}
          {/* The queue indicator lives with the bottom-left affordance cluster, not beside the primary
              action — it is a status of the pending work, kin to the tools, not a second send button.
              It opens: a bare count is indistinguishable from a stuck counter, so the messages
              themselves have to be reachable. Same native `popover` as the context chip, for the same
              reason — the composer clips `overflow: hidden`, and the top layer escapes it. */}
          {queued.length > 0 ? <QueuedMessages queued={queued} deliverable={queueDeliverable} /> : null}
        </div>
        <div>
          {contextUsage}
          {primaryAction === 'stop' ? (
            // ■ interrupts THIS turn (onInterrupt → Core semantic interrupt); it does not end the Run.
            // Terminating the whole session is a separate action that lives in the Tabbar, so the mark and
            // its accessible name/tooltip say "current turn" to keep the two objects distinct. Behaviour is
            // unchanged — this is a mark-and-wording fix, so onInterrupt, position and weight stay put.
            <button
              type="button"
              className="composer-send composer-send--working"
              disabled={disabled || !onInterrupt}
              onClick={onInterrupt}
              aria-label="Interrupt the current turn"
              title="Interrupt the current turn — the session keeps running"
            >
              <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" /> Interrupt
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Send"
            >
              Send <ArrowUp size={13} />
            </button>
          )}
        </div>
      </div>
      {suggestions.length && !disabled ? <div className="composer__suggestions" role="listbox" aria-label={`Agent ${suggestionKind ?? 'suggestions'}`}>
        {suggestions.map((command) => <button type="button" role="option" aria-selected="false" key={command.text}
          onClick={() => { onSelectSuggestion?.(command.text, suggestionKind!); onChange(`${command.text} `) }}>{command.text}<small>{command.description}</small></button>)}
      </div> : null}
      <summary className="composer__disclosure" title="Collapse or expand message tools">
        <MessageSquare size={12} /><span>Message tools</span>{value ? <small>Draft</small> : null}<ChevronDown size={12} />
      </summary>
    </details>
  )
}

/**
 * The queue badge: count on the chip, the actual queued prompts in a click-opened card.
 *
 * The count alone was the defect — "2" beside a working Agent is indistinguishable from a counter that
 * got stuck, so it reads as a bug even when it is correct. Seeing the text you queued is what makes it
 * legible as pending work.
 *
 * Order is delivery order (the store appends), and it is labelled as such, because "which one goes
 * next" is the actual question when you queue more than one. Each entry is clamped to a few lines by
 * CSS rather than truncated here: the full text stays in the DOM for screen readers and for select-copy.
 *
 * `deliverable` splits one label into two, because the promise "queued for delivery" has a precondition
 * this component used to assert unconditionally. The store only drains while the run is `running`, so
 * after it exits these entries are stranded — and the old copy went on telling the user they were on
 * their way, which is the worst moment to be wrong: the words the user typed are still in there, and
 * nothing else on screen says they will not arrive. Undeliverable is a plain statement plus where the
 * text still is, NOT an error — the entries are intact and copyable, which is the honest remedy while
 * the run is gone. We do not offer to resend: this component cannot know whether a next run is the same
 * Agent, and silently replaying a stale steer into a fresh session is worse than saying nothing.
 */
function QueuedMessages({ queued, deliverable }: { queued: readonly string[]; deliverable: boolean }) {
  const cardId = useId()
  const label = deliverable
    ? `${queued.length} message${queued.length === 1 ? '' : 's'} queued for delivery`
    : `${queued.length} message${queued.length === 1 ? '' : 's'} never delivered`
  return (
    <>
      <button type="button" className="composer__queued" aria-label={label}
        popoverTarget={cardId} popoverTargetAction="toggle">
        <MessageSquare size={12} aria-hidden="true" /> {queued.length}
      </button>
      <div id={cardId} popover="auto" className="composer__queued-card" aria-label="Queued messages">
        <h3>{label}</h3>
        <ol>
          {/* Index key: the queue is an append-and-drain list of plain strings with no identity of its
              own, and two identical prompts are a legitimate queue state — so text is not a key. */}
          {queued.map((prompt, index) => <li key={index}>{prompt}</li>)}
        </ol>
        <p>
          {deliverable
            ? 'Delivered in this order when the Agent finishes its current turn.'
            : 'The Agent run ended before these were sent. Copy anything you still need — they are kept here, not sent.'}
        </p>
      </div>
    </>
  )
}
