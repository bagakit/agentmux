import { AtSign, CornerDownLeft, Paperclip, Square } from 'lucide-react'

export type AgentComposerProps = {
  value: string
  disabled: boolean
  placeholder: string
  activeFile?: string
  isWorking?: boolean
  onChange(value: string): void
  onSubmit?: () => void
  onInterrupt?: () => void
  onReferenceActiveFile?: () => void
  onAttach?: () => void
}

export function AgentComposer({
  value,
  disabled,
  placeholder,
  activeFile,
  isWorking = false,
  onChange,
  onSubmit,
  onInterrupt,
  onReferenceActiveFile,
  onAttach
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
          if (event.key === 'Enter' && !event.shiftKey) {
            if (isWorking && onInterrupt) {
              event.preventDefault()
              onInterrupt()
            } else if (canSubmit) {
              event.preventDefault()
              onSubmit?.()
            }
          }
        }}
        placeholder={placeholder}
        rows={1}
      />
      <div className="composer__toolbar">
        <div>
          <button
            type="button"
            className="composer-tool"
            disabled={disabled || !activeFile || !onReferenceActiveFile}
            onClick={onReferenceActiveFile}
            title="Reference the last active file"
          >
            <AtSign size={14} /> {activeFile ? activeFile.split('/').at(-1) : 'File'}
          </button>
          <button
            type="button"
            className="composer-tool"
            disabled={disabled || !onAttach}
            onClick={onAttach}
            title={onAttach ? 'Attach a file' : 'Attachments are not available yet'}
          >
            <Paperclip size={14} /> Attach
          </button>
        </div>
        <div>
          <button
            type="button"
            className="composer-tool composer-tool--danger"
            disabled={disabled || !onInterrupt}
            onClick={onInterrupt}
            title="Interrupt active agent turn"
          >
            <Square size={12} /> Stop turn
          </button>
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
