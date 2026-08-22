import { FolderOpen, PackageOpen } from 'lucide-react'
import { isSystemArtifactPath, type TerminalPathLink } from './terminal-path-link'
import { revealInFileManagerLabel } from './host-platform'

/** The one click route for terminal file links; system errors never fall back to an editor tab. */
export async function openTerminalFileLink(input: {
  link: TerminalPathLink
  local: boolean
  openSystem(path: string): Promise<void>
  openFile(link: TerminalPathLink): Promise<void>
}): Promise<void> {
  if (isSystemArtifactPath(input.link.path)) {
    if (!input.local) throw new Error('This file is on a remote host. Open it on that host or download it first.')
    await input.openSystem(input.link.path)
  } else {
    await input.openFile(input.link)
  }
}

export type TerminalFileMenuAction = {
  key: 'reveal' | 'open-system'
  label: string
  title: string
  icon: typeof FolderOpen
  onSelect(): void
}

export function terminalFileMenuActions(input: {
  link: TerminalPathLink | null
  local: boolean
  onReveal(path: string): void
  onOpenSystem(path: string): void
}): TerminalFileMenuAction[] {
  if (!input.link || !input.local) return []
  const path = input.link.path
  const revealLabel = revealInFileManagerLabel()
  const actions: TerminalFileMenuAction[] = [{
    key: 'reveal', label: revealLabel, title: `${revealLabel} · ${path}`, icon: FolderOpen,
    onSelect: () => input.onReveal(path)
  }]
  if (isSystemArtifactPath(path)) actions.push({
    key: 'open-system', label: 'Open with system', title: `Open with system · ${path}`, icon: PackageOpen,
    onSelect: () => input.onOpenSystem(path)
  })
  return actions
}
