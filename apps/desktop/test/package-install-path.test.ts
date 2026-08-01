import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { canonicalInstallPath } from '../scripts/package-identity.mjs'

describe('package installation boundary', () => {
  it('wires the package installer and report to the canonical path helper', async () => {
    const [packager, reporter, rootManifest] = await Promise.all([
      readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/report-desktop-package.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8')
    ])
    expect(packager.match(/canonicalInstallPath/g)?.length ?? 0).toBeGreaterThan(0)
    expect(reporter.match(/canonicalInstallPath/g)?.length ?? 0).toBeGreaterThan(0)
    expect(packager).toContain("const trashRoot = join(homedir(), '.Trash')")
    expect(packager).toContain('previous_install_trashed=')
    expect(packager).toContain('Could not install candidate or restore the previous application')
    expect(packager).not.toMatch(/rm\(destination,\s*\{\s*recursive:\s*true/)
    expect(JSON.parse(rootManifest).scripts['package:mac']).toBe('pnpm --filter @agentmux/desktop package:mac')
    expect(JSON.parse(rootManifest).scripts['package:mac:install']).toBe('pnpm --filter @agentmux/desktop package:mac:install')
    expect(JSON.parse(rootManifest).scripts['package:mac:report']).toBe('pnpm --filter @agentmux/desktop report:package')
    expect(canonicalInstallPath('/Users/alice')).toBe('/Users/alice/Applications/AgentMux.app')
  })
})
