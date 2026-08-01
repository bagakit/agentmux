import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('Workspace rebind is wired through the desktop boundary', () => {
  it('declares the verb in contracts and preload', () => {
    expect(read('../src/shared/contracts.ts')).toContain('rebindLocalFolder(workspaceId: string)')
    expect(read('../src/preload/index.ts')).toContain("'workspaces:rebindLocalFolder'")
  })

  it('updates the existing record in main and exposes a preview implementation', () => {
    const ipc = read('../src/main/ipc.ts')
    expect(ipc).toContain("handle('workspaces:rebindLocalFolder'")
    expect(ipc).toContain('item.id === workspaceId ? updated : item')
    expect(read('../src/renderer/src/lib/api.ts')).toContain('rebindLocalFolder: async () => null')
  })
})
