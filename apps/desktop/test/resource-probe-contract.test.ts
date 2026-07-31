import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const probe = readFileSync(
  new URL('../src/main/resource-probe.ts', import.meta.url),
  'utf8'
)
const harness = readFileSync(
  new URL('../scripts/measure-desktop-resources.mjs', import.meta.url),
  'utf8'
)
const main = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
)

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0] ?? '')
}

describe('desktop resource probe contract', () => {
  it('scans real probe sources instead of passing on an empty result', () => {
    expect(probe.length).toBeGreaterThan(10_000)
    expect(harness.length).toBeGreaterThan(5_000)
    expect(matches(probe, /sample\(['"][^'"]+['"]/g).length).toBeGreaterThan(5)
    expect(matches(probe, /owners\.[A-Za-z]+/g).length).toBeGreaterThan(20)
  })

  it('keeps the reviewed six-stage order and separate release observations', () => {
    for (const stage of [
      'idle',
      'single-hidden-workspace',
      'multiple-hidden-workspaces-tabs',
      'terminal',
      'monaco',
      'browser'
    ]) {
      expect(probe).toContain(`'${stage}'`)
    }
    expect(probe).toContain('phaseOrder')
    expect(probe).toContain("'terminal-baseline'")
    expect(probe).toContain("'browser-released'")
    expect(probe).toContain('releaseCycles')
  })

  it('records identity and attribution at every sample', () => {
    for (const field of [
      'agentmuxCommit',
      'electron',
      'ctxmuxManifest',
      'sourceCommit',
      'sourceTree',
      'protocolVersion',
      'artifactPlatform',
      'daemonSha256',
      'platform',
      'coreCtxmux',
      'rendererMainSurface',
      'processWorkingSetKiB'
    ]) {
      expect(probe).toContain(field)
    }
    expect(probe).toContain('identity: structuredClone(identity)')
    expect(probe).toContain('working-set observations; Browser helpers/shared pages')
  })

  it('uses expose-gc and labels heap/RSS as observations, not leakage claims', () => {
    expect(harness).toContain("'--js-flags=--expose-gc'")
    expect(probe).toContain('gcAvailable')
    expect(probe).toContain('heapUsedAfterGcKiB')
    expect(probe).toMatch(/RSS\/working-set may retain allocator pages/)
    expect(probe).toMatch(/working-set\/RSS is an observation only/)
    expect(probe).toMatch(/before calling a leak/)
  })

  it('keeps working-set limits diagnostic instead of turning allocator noise into a gate failure', () => {
    const diagnosticMarkers = matches(probe, /diagnostic-only|diagnosticWorkingSet|WORKING_SET_DIAGNOSTIC_NOTE/g)
    expect(diagnosticMarkers.length).toBeGreaterThan(0)
    expect(probe).toContain("mode: 'diagnostic-only'")
    expect(probe).not.toContain('Desktop Browser exceeded its working-set budget.')
    expect(probe).not.toContain('Desktop steady-state working set kept growing across release cycles.')
  })

  it('isolates fixture/user-data/runtime paths and proves cleanup', () => {
    for (const token of [
      "mkdtemp(join(tmpdir(), 'agentmux-desktop-resource-'))",
      "mkdtemp('/private/tmp/amx-desktop-resource-')",
      'AGENTMUX_DESKTOP_USER_DATA',
      'AGENTMUX_RUNTIME_DIRECTORY',
      'AGENTMUX_DESKTOP_RESOURCE_REPORT',
      'resource-probe.ts',
      '20_000',
      'assertProbePathsRemoved',
      'receiptlessDaemonCleanup'
    ]) {
      expect(harness).toContain(token)
    }
    expect(harness).toMatch(/rm\(directory, \{ recursive: true, force: true \}\)/)
    expect(harness).toMatch(/rm\(runtimeDirectory, \{ recursive: true, force: true \}\)/)
  })

  it('captures worktree identity before and after without editing the source tree', () => {
    expect(harness).toContain("git', ['status', '--porcelain=v1', '--untracked-files=all']")
    expect(harness).toContain('worktreeStable')
    expect(harness).toContain('sourceCommitStable')
    expect(harness).toContain('statusAtStart')
    expect(harness).toContain('statusAtEnd')
    expect(harness).toContain('isolatedRuntime: true')
  })

  it('keeps a real production caller and a bounded outer timeout', () => {
    expect(matches(main, /runDesktopResourceProbe\(/g).length).toBeGreaterThan(0)
    expect(harness).toContain('AGENTMUX_DESKTOP_RESOURCE_TIMEOUT_MS')
    expect(harness).toContain('Number.isFinite(timeoutMs)')
  })
})
