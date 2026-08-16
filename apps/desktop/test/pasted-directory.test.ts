import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pastedDirectory } from '../src/main/pasted-directory.js'

// T-002: the pasted/captured image directory is derived in ONE place. Two write sites (paste, capture)
// and a read IPC all target it, and the read's trust boundary is precisely the write sites' target —
// so a second hand-copied `join(home, '.agentmux', 'pasted')` would let them drift silently, surfacing
// only as "the screenshot shows but the paste does not". This pins the derived target verbatim (a
// "顺手规范化" that moves it would move existing files on disk) and proves both write sites route
// through the constant rather than re-authoring the literal.

const IPC = fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url))
const SCREENSHOT = fileURLToPath(new URL('../src/main/composer-screenshot.ts', import.meta.url))

describe('pastedDirectory — one derivation, target frozen', () => {
  it('derives exactly <home>/.agentmux/pasted — the落盘目标 verbatim', () => {
    // Absolute-verbatim, not "endsWith('pasted')": the second is satisfied by a rename that still ends
    // in pasted, and the whole point is that the on-disk location does not move.
    expect(pastedDirectory('/Users/dev')).toBe('/Users/dev/.agentmux/pasted')
    // Derives against the given home rather than a hardcoded one.
    expect(pastedDirectory('/tmp/x')).toBe('/tmp/x/.agentmux/pasted')
  })

  it('both write sites reference the shared constant, and neither re-authors the literal', () => {
    const ipc = readFileSync(IPC, 'utf8')
    const screenshot = readFileSync(SCREENSHOT, 'utf8')
    // Both call the single derivation.
    expect(ipc).toContain('pastedDirectory(app.getPath(\'home\'))')
    expect(screenshot).toContain('pastedDirectory(home)')
    // And neither hand-copies `'.agentmux', 'pasted'` — that copy is the drift this task removes. The
    // SSOT module is the only place that literal may live.
    expect(ipc).not.toMatch(/'\.agentmux'\s*,\s*'pasted'/u)
    expect(screenshot).not.toMatch(/'\.agentmux'\s*,\s*'pasted'/u)
  })
})
