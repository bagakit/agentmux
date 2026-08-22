import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { hostPlatform, revealInFileManagerLabel } from '../src/renderer/src/lib/host-platform'
import { terminalFileMenuActions } from '../src/renderer/src/lib/terminal-file-action'

const menuSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/TerminalContextMenu.tsx', import.meta.url)), 'utf8')
const viewSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)), 'utf8')
const actionSource = readFileSync(fileURLToPath(new URL('../src/renderer/src/lib/terminal-file-action.ts', import.meta.url)), 'utf8')

describe('terminal path context actions', () => {
  it('uses the shared platform reveal label and keeps the action group conditional', () => {
    expect(revealInFileManagerLabel(hostPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)'))).toBe('Reveal in Finder')
    expect(revealInFileManagerLabel(hostPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe('Reveal in File Explorer')
    expect(revealInFileManagerLabel(hostPlatform('Mozilla/5.0 (X11; Linux x86_64)'))).toBe('Reveal in File Manager')
    expect(menuSource).toContain('pathActions.length > 0 ? (')
    expect(menuSource).toContain('action.label')
    expect(actionSource).toContain("label: 'Open with system'")
  })

  it('only exposes reveal/open actions for a local path hit', () => {
    const reveal = vi.fn()
    const openSystem = vi.fn()
    const artifact = { index: 0, length: 12, path: 'dist/app.dmg' }
    expect(terminalFileMenuActions({ link: artifact, local: true, onReveal: reveal, onOpenSystem: openSystem }).map((item) => item.key))
      .toEqual(['reveal', 'open-system'])
    expect(terminalFileMenuActions({ link: { ...artifact, path: 'src/app.ts' }, local: true, onReveal: reveal, onOpenSystem: openSystem }).map((item) => item.key))
      .toEqual(['reveal'])
    expect(terminalFileMenuActions({ link: artifact, local: false, onReveal: reveal, onOpenSystem: openSystem })).toEqual([])
    const action = terminalFileMenuActions({ link: artifact, local: true, onReveal: reveal, onOpenSystem: openSystem })
    action[0]!.onSelect()
    action[1]!.onSelect()
    expect(reveal).toHaveBeenCalledExactlyOnceWith('dist/app.dmg')
    expect(openSystem).toHaveBeenCalledExactlyOnceWith('dist/app.dmg')
  })

  it('wires reveal and system open through the typed files seam from the real terminal caller', () => {
    expect(viewSource).toContain('pathActions={terminalFileMenuActions({')
    expect(viewSource).toContain('api.files.reveal(linkOriginRef.current.workspaceId, path)')
    expect(viewSource).toContain('api.files.openSystem(linkOriginRef.current.workspaceId, path)')
    expect(viewSource).toContain('terminalPathAtPointer(')
  })
})
