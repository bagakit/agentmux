import { AtSign, CornerDownLeft, Paperclip, Square } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'

export function RichComposer() {
  const [text, setText] = useState('')
  const activeFile = useAppStore((state) => state.activeDocument?.path)
  const sessionId = useAppStore((state) => state.activeSessionId)
  const send = useAppStore((state) => state.send)
  const interrupt = useAppStore((state) => state.interrupt)

  async function submit(): Promise<void> {
    if (!text.trim()) return
    const value = text
    setText('')
    await send(value)
  }

  function addFileReference(): void {
    if (!activeFile) return
    setText((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${activeFile} `)
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={sessionId ? 'Ask, steer, or paste a command…' : 'Launch an agent to start'}
        disabled={!sessionId}
        rows={2}
      />
      <div className="composer__toolbar">
        <div>
          <button className="composer-tool" disabled={!activeFile} onClick={addFileReference} title="Reference active file">
            <AtSign size={14} /> File
          </button>
          <button className="composer-tool" disabled title="Attachments are not in this slice">
            <Paperclip size={14} /> Attach
          </button>
        </div>
        <div>
          <button className="composer-tool composer-tool--danger" disabled={!sessionId} onClick={() => void interrupt()}>
            <Square size={12} /> Stop turn
          </button>
          <button className="composer-send" disabled={!sessionId || !text.trim()} onClick={() => void submit()}>
            Send <CornerDownLeft size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
