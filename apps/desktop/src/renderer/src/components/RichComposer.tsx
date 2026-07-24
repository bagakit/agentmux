import { AtSign, CornerDownLeft, Paperclip, Square } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'

export function RichComposer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('')
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const workspace = useAppStore((state) =>
    state.config?.workspaces.find(
      (item) => item.hostId === session?.hostId && item.path === session.workspacePath
    )
  )
  const activeFile = useAppStore((state) =>
    workspace ? state.lastActiveFileByWorkspace[workspace.id] : undefined
  )
  const send = useAppStore((state) => state.send)
  const interrupt = useAppStore((state) => state.interrupt)
  const canInteract = session?.processState === 'running'

  async function submit(): Promise<void> {
    if (!text.trim()) return
    const value = text
    setText('')
    await send(sessionId, value)
  }

  function addFileReference(): void {
    if (!activeFile) return
    setText((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${activeFile} `)
  }

  return (
    <div className="composer">
      <textarea
        disabled={!canInteract}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={canInteract ? 'Ask, steer, or paste a command…' : 'Terminal is not connected'}
        rows={1}
      />
      <div className="composer__toolbar">
        <div>
          <button className="composer-tool" disabled={!activeFile} onClick={addFileReference} title="Reference the last active file">
            <AtSign size={14} /> {activeFile ? activeFile.split('/').at(-1) : 'File'}
          </button>
          <button className="composer-tool" disabled title="Attachments are not available yet">
            <Paperclip size={14} /> Attach
          </button>
        </div>
        <div>
          <button className="composer-tool composer-tool--danger" disabled={!canInteract} onClick={() => void interrupt(sessionId)}>
            <Square size={12} /> Stop turn
          </button>
          <button className="composer-send" disabled={!canInteract || !text.trim()} onClick={() => void submit()}>
            Send <CornerDownLeft size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
