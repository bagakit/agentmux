import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { canonicalInstallPath } from '../scripts/package-identity.mjs'

describe('package installation boundary', () => {
  it('wires the package installer and report to the canonical path helper', async () => {
    const [packager, reporter] = await Promise.all([
      readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/report-desktop-package.mjs', import.meta.url), 'utf8')
    ])
    expect(packager.match(/canonicalInstallPath/g)?.length ?? 0).toBeGreaterThan(0)
    expect(reporter.match(/canonicalInstallPath/g)?.length ?? 0).toBeGreaterThan(0)
    expect(canonicalInstallPath('/Users/alice')).toBe('/Users/alice/Applications/AgentMux.app')
  })
})
