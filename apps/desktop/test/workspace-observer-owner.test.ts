import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace observer ownership', () => {
  it('binds the production observer to host IPC lifetime', async () => {
    const source = await readFile(new URL('../src/main/workspace-files.ts', import.meta.url), 'utf8')
    expect(source).toContain("process.once('disconnect'")
    expect(source).toContain("stdio: ['pipe', 'pipe', 'pipe', 'ipc']")
    expect(source).toContain('watcher.close()')
  })
})
