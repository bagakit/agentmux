import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('package launch source diagnostics', () => {
  it('reports known copies and the running executable path instead of trusting the version string', async () => {
    const report = await readFile(new URL('../scripts/report-desktop-package.mjs', import.meta.url), 'utf8')
    expect(report).toContain('knownApplicationPaths')
    expect(report).toContain('runningAgentMuxProcesses')
    expect(report).toContain('runningPathMismatches')
    expect(report).toContain('runningCanonical')
    expect(report).toContain('staleCopies')
    expect(report).toContain('canonicalMatchesCandidate')
    expect(report).toContain('candidateMatchesCheckout')
    expect(report).toContain('canonicalMatchesCheckout')
    expect(report).not.toContain('CFBundleVersion')
  })
})
