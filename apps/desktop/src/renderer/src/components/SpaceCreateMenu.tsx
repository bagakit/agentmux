import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FolderOpen, NotebookText, Plus } from 'lucide-react'
import { MoteIcon } from './MoteIcon'
import { useState } from 'react'
import { useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'

export function SpaceCreateMenu({ onOpenFolder }: { onOpenFolder(): Promise<void> }) {
  const createTopic = useAppStore((state) => state.createScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try { await action() } catch (error) { reportError(error) } finally { setBusy(false) }
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-button" aria-label="Add Space" title="Add Space" disabled={busy}><Plus size={15} /></button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <DropdownMenu.Content className="tab-context-menu" collisionPadding={8} align="end">
          <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => void run(onOpenFolder)}>
            <FolderOpen size={14} /><span>Open Folder As a Project</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => void run(() => createTopic())}>
            <NotebookText size={14} /><span>Create Another Topic</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => void run(() => createTopic('mote'))}>
            <MoteIcon size={14} /><span>Create Mote</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
