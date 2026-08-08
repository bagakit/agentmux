import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import { applyWorkspacePathRebind } from '../src/renderer/src/lib/workspace-path-recovery.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: '__scratch__', name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'moved', name: 'Iconmarker', hostId: 'local', path: '/old/iconmarker', kind: 'folder' },
    { id: 'other', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

describe('Workspace path recovery', () => {
  it('replaces only the locator and preserves Workspace identity', () => {
    const next = applyWorkspacePathRebind(config, {
      ...config.workspaces[1]!,
      path: '/new/iconmarker'
    })
    expect(next.workspaces.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: '__scratch__', path: '/scratch' },
      { id: 'moved', path: '/new/iconmarker' },
      { id: 'other', path: '/other' }
    ])
    expect(next.workspaces[1]!.name).toBe('Iconmarker')
  })

  it('keeps the recovery action beside Retry and wires it to the rebind API', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Choose new folder')
    expect(source).toContain('api.workspaces.rebindLocalFolder(workspaceId)')
    expect(source).toContain('applyWorkspacePathRebind(current, updated)')
  })
})
