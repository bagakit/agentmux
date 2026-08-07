import { AtSign, CornerDownLeft, Paperclip, Square } from 'lucide-react'
import type { AgentPostureControl } from '@agentmux/core'
import { PosturePicker } from './PosturePicker'
import { ComposerTextarea } from './ComposerTextarea'

export type AgentComposerProps = {
  value: string
  disabled: boolean
  placeholder: string
  activeFile?: string
  // Which action the primary button performs. `stop` while a turn is in flight, `send` otherwise. This is
  // a SEPARATE question from whether Enter submits: a working Agent shows Stop yet still takes a steer, so
  // this must not gate the Enter handler — that was the bug where one `isWorking` flag did both jobs.
  primaryAction?: 'send' | 'stop'
  postureControl?: AgentPostureControl
  onChange(value: string): void
  onSubmit?: () => void
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
  primaryAction = 'send',
  postureControl,
  onChange,
  onSubmit,
  onInterrupt,
  onReferenceActiveFile,
  onAttach,
  onPasteImage,
  onSetPosture
}: AgentComposerProps) {
  const canSubmit = !disabled && Boolean(onSubmit) && Boolean(value.trim())

  return (
    <div className="composer" data-agent-composer="true">
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
          // IME candidate confirmation also arrives as Enter (often with `isComposing` or keyCode 229).
          // Let the IME commit first; otherwise the composer submits the pre-conversion draft and the
          // user sees missing/replaced characters in the Agent conversation.
          const composing = event.nativeEvent?.isComposing || event.keyCode === 229
          if (event.key === 'Enter' && !event.shiftKey && !composing && canSubmit) {
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
            <Paperclip size={14} /> Attach
          </button>
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
        </div>
        <div>
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
              <Square size={13} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Send"
            >
              Send <CornerDownLeft size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
