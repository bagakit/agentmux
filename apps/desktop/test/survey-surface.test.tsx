import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFile(
  fileURLToPath(new URL('../src/renderer/src/components/GlobalSurveySurface.tsx', import.meta.url)),
  'utf8'
)

describe('Survey browser-first surface', () => {
  it('keeps the first interaction browser-like and delegates page ownership to Space', async () => {
    const source = await SOURCE
    expect(source).toContain('Search or enter a web address')
    expect(source).toContain('autoFocus')
    expect(source).toContain('createBrowser(layout.activeGroupId, undefined, url)')
    expect(source).toContain("setMainSurface('workbench')")
    expect(source).toContain('SCRATCH_WORKSPACE_ID')
    expect(source).not.toContain('launchAgent(')
    expect(source).not.toContain('createSession(')
  })

  it('rejects non-address input with a recoverable inline message', async () => {
    const source = await SOURCE
    expect(source).toContain("setMessage('Enter a web address to open in Space.')")
    expect(source).toContain('role="status"')
  })
})
