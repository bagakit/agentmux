import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Wiring guard for the main-process window setup. The pure projections in window-geometry.ts are unit
 * tested directly, but the *call site* in index.ts cannot be imported (its module runs Electron app
 * side effects on load). Reverting the constructor to the fixed `width: 1480 / height: 940` literal —
 * or dropping the persistence registration — would leave every pure test green while regressing the
 * feature, so this scans index.ts source for the load-bearing wiring.
 *
 * Comments are stripped first and every assertion anchors on a code shape a comment cannot supply
 * (`width: 1480`, `...windowConstructorGeometry(`, `registerWindowStatePersistence(`). The prose note
 * that mentions "1480×940" is therefore invisible here — deleting the real code, not the comment, is
 * what turns these red.
 */

const here = dirname(fileURLToPath(import.meta.url))
const indexPath = join(here, '../src/main/index.ts')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('main window setup wiring', () => {
  it('drives the BrowserWindow size from persisted geometry, not the fixed literal', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    // The scan must actually find the constructor — an empty read must not pass silently.
    expect(source).toContain('new BrowserWindow(')
    // The persisted geometry is spread into the constructor options.
    expect(source).toContain('...windowConstructorGeometry(persistedGeometry)')
    // The fixed literal must be gone from code (it survives only in a comment, which is stripped).
    expect(source).not.toMatch(/width:\s*1480/)
    expect(source).not.toMatch(/height:\s*940/)
  })

  it('registers the window-state persistence owner (geometry capture + unload flush)', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    expect(source).toContain('registerWindowStatePersistence(window, windowGeometryStore)')
  })
})
