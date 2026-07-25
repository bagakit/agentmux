import { AtSign, CornerDownLeft, Paperclip, Square } from 'lucide-react'
import type { AgentPostureControl } from '@agentmux/core'
import { PosturePicker } from './PosturePicker'

export type AgentComposerProps = {
  value: string
  disabled: boolean
  placeholder: string
  activeFile?: string
  isWorking?: boolean
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
  isWorking = false,
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
      <textarea
        aria-label="Message Agent"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !isWorking && canSubmit) {
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
          {isWorking ? (
            <button
              type="button"
              className="composer-send composer-send--working"
              disabled={disabled || !onInterrupt}
              onClick={onInterrupt}
              aria-label="Stop turn"
            >
              Stop <Square size={12} />
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
