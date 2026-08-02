import { mkdtemp, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatPackageReportPreflightError,
  inspectPackageReportPaths,
  PACKAGE_REPORT_NEXT_COMMAND
} from '../scripts/package-report-preflight.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('package report preflight', () => {
  it('package report command has a clean-build smoke path when no candidate exists', async () => {
    const candidate = join(process.cwd(), 'release', 'mac', 'AgentMux.app')
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['scripts/report-desktop-package.mjs'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    if (await stat(candidate).then(() => true, () => false)) {
      expect(result.code, result.stderr).not.toBe(1)
      return
    }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`missing release candidate at ${candidate}`)
    expect(result.stderr).toContain(`Run \`${PACKAGE_REPORT_NEXT_COMMAND}\``)
    expect(result.stderr).not.toContain('ENOENT')
    expect(result.stdout).not.toContain('Error: ENOENT')
  })

  it('returns an actionable diagnostic instead of exposing an ENOENT stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-'))
    roots.push(root)
    const paths = {
      appPath: join(root, 'release', 'mac', 'AgentMux.app'),
      rendererAssets: join(root, 'release', 'mac', 'AgentMux.app', 'Contents', 'Resources', 'app', 'out', 'renderer', 'assets'),
      mainExecutablePath: join(root, 'release', 'mac', 'AgentMux.app', 'Contents', 'MacOS', 'AgentMux'),
      dmgPath: join(root, 'release', 'mac', 'AgentMux-0.1.0-darwin-arm64.dmg')
    }

    const result = await inspectPackageReportPaths(paths)
    expect(result.ok).toBe(false)
    const diagnostic = formatPackageReportPreflightError(result.missing)
    expect(diagnostic).toContain(`missing release candidate at ${paths.appPath}`)
    expect(diagnostic).toContain(`Run \`${PACKAGE_REPORT_NEXT_COMMAND}\``)
    expect(diagnostic).not.toContain('ENOENT')
    expect(diagnostic).not.toContain('at async')
  })

  it('checks every release artifact when the bundle directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-complete-'))
    roots.push(root)
    const appPath = join(root, 'AgentMux.app')
    const paths = {
      appPath,
      rendererAssets: join(appPath, 'Contents', 'Resources', 'app', 'out', 'renderer', 'assets'),
      mainExecutablePath: join(appPath, 'Contents', 'MacOS', 'AgentMux'),
      dmgPath: join(root, 'AgentMux.dmg')
    }
    const result = await inspectPackageReportPaths(paths)
    expect(result.ok).toBe(false)
    expect(result.missing.map(({ label }) => label)).toEqual([
      'release candidate',
      'renderer assets',
      'main executable',
      'DMG'
    ])
  })
})
