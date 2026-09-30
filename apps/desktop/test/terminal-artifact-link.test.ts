import { describe, expect, it, vi } from 'vitest'
import { isSystemArtifactPath } from '../src/renderer/src/lib/terminal-path-link'
import { terminalPathLinkAtBufferCell } from '../src/renderer/src/lib/terminal-link-range'
import { Terminal } from '@xterm/xterm'
import { openTerminalFileLink } from '../src/renderer/src/lib/terminal-file-action'

describe('terminal system artifact paths', () => {
  it('recognizes host-openable package, app and archive suffixes case-insensitively', () => {
    expect(isSystemArtifactPath('dist/AgentMux.DMG')).toBe(true)
    expect(isSystemArtifactPath('release/AgentMux.app')).toBe(true)
    expect(isSystemArtifactPath('release/agentmux.AppImage')).toBe(true)
    expect(isSystemArtifactPath('downloads/tool.msi')).toBe(true)
    expect(isSystemArtifactPath('downloads/source.tar.gz')).toBe(true)
  })

  it('does not turn ordinary source paths or suffix-like directory names into artifacts', () => {
    expect(isSystemArtifactPath('apps/desktop/src/main.ts')).toBe(false)
    expect(isSystemArtifactPath('apps/app/src/index.ts')).toBe(false)
    expect(isSystemArtifactPath('README.md')).toBe(false)
    expect(isSystemArtifactPath('release/app')).toBe(false)
  })

  it('finds the path under a context-menu cell without probing the disk', async () => {
    const terminal = new Terminal({ allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write('download release/AgentMux.dmg now', resolve))
      const link = terminalPathLinkAtBufferCell(terminal.buffer.active, 13, 1, '/workspace')
      expect(link?.path).toBe('release/AgentMux.dmg')
      expect(terminalPathLinkAtBufferCell(terminal.buffer.active, 1, 1, '/workspace')).toBeNull()
    } finally { terminal.dispose() }
  })

  it('opens artifacts with the OS and source files in the editor', async () => {
    const openSystem = vi.fn(async () => {})
    const openFile = vi.fn(async () => {})
    await openTerminalFileLink({ link: { index: 0, length: 12, path: 'dist/app.dmg' }, local: true, openSystem, openFile })
    expect(openSystem).toHaveBeenCalledExactlyOnceWith('dist/app.dmg')
    expect(openFile).not.toHaveBeenCalled()
    const link = { index: 0, length: 10, path: 'src/app.ts', line: 2 }
    await openTerminalFileLink({ link, local: true, openSystem, openFile })
    expect(openFile).toHaveBeenCalledExactlyOnceWith(link)
    expect(openSystem).toHaveBeenCalledTimes(1)
  })

  it('reports remote artifacts and failed system opens without creating an editor tab', async () => {
    const openSystem = vi.fn(async () => { throw new Error('The application could not open this file') })
    const openFile = vi.fn(async () => {})
    const link = { index: 0, length: 12, path: 'dist/app.dmg' }
    await expect(openTerminalFileLink({ link, local: false, openSystem, openFile })).rejects.toThrow('remote host')
    expect(openSystem).not.toHaveBeenCalled()
    await expect(openTerminalFileLink({ link, local: true, openSystem, openFile })).rejects.toThrow('could not open')
    expect(openFile).not.toHaveBeenCalled()
  })
})
