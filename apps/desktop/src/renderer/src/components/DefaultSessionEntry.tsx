import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'

export function DefaultSessionEntry({ placement = 'topbar', respectHidden = true }: { placement?: 'topbar' | 'board'; respectHidden?: boolean }) {
  const config = useAppStore((state) => state.config)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const hidden = useAppStore((state) => state.defaultSessionLauncherHidden)
  const setHidden = useAppStore((state) => state.setDefaultSessionLauncherHidden)
  const [opening, setOpening] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  async function openDefaultTopic(): Promise<void> {
    if (opening) return
    const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
    if (!scratch) return
    setOpening(true)
    try {
      await selectWorkspace(scratch.id)
      await openScratchTopic('launcher:default')
    } finally {
      setOpening(false)
    }
  }

  const className = placement === 'board' ? 'global-default-session' : 'default-session-entry'
  if (hidden && respectHidden) {
    return <button type="button" className={`${className}__recover`} onClick={() => setHidden(false)} title="Show Default Session launcher"><Sparkles size={13} /> Default Session</button>
  }
  return (
    <div className={className}>
      <button
        type="button"
        className={`${className}__button`}
        onClick={() => void openDefaultTopic()}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen((value) => !value) }}
        aria-label="Open Default Session"
        title="Open Default Session"
      >
        <Sparkles size={14} /> <span>{opening ? 'Opening…' : 'Default Session'}</span>
      </button>
      {menuOpen ? (
        <div className={`${className}__menu`} role="menu">
          <button type="button" role="menuitem" onClick={() => { setHidden(true); setMenuOpen(false) }}>{placement === 'board' ? 'Hide launcher' : 'Move to Board'}</button>
          <button type="button" role="menuitem" onClick={() => { setWorkspaceTool('files-branches'); setMenuOpen(false) }}>Show Topic files</button>
        </div>
      ) : null}
    </div>
  )
}
