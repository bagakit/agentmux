// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync }))

const root = resolve(import.meta.dirname, '../../..')
const verifier = resolve(root, 'apps/desktop/scripts/verify-launcher-device-dialog.mjs')
const oracle = resolve(root, 'apps/desktop/scripts/fixtures/space-launcher/region-workflow.cjs')
const sourceRoot = 'apps/desktop/src/renderer/src/'
const sources = {
  [sourceRoot + 'components/AgentWorkModeSetup.tsx']: 'setup-source',
  [sourceRoot + 'components/SourceAgentTargetSetup.tsx']: 'source-source',
  [sourceRoot + 'components/AgentWorkProjectAnchor.tsx']: 'anchor-source',
  [sourceRoot + 'components/LauncherAgentDevice.tsx']: 'device-source',
  [sourceRoot + 'components/SelectionField.tsx']: 'selection-host',
  'packages/client-ui/src/components/SelectionField.tsx': 'selection-source',
}
const styles = {
  [sourceRoot + 'components/agent-work-mode.css']: 'setup-style',
  ['packages/client-ui/src/styles/selection-field.css']: 'selection-style',
}
const failureText = {
  'dialog-root-scroll': 'Location Cancel and Apply are visible before any scrolling in a short Region',
  'dialog-body-height': 'Only the arrangement body scrolls after expanding complete details',
  'dialog-footer-order': 'Custom startup action stays inside progressive details',
  'dialog-path-disclosure': 'Complete original project path is disclosed without clamping',
  'dialog-menu-boundary': 'Overlay height stays in its original Region',
  'dialog-device-tail': 'Every configured Agent device remains available',
  'dialog-device-scroll': 'Native scrolling reaches the last configured Agent device',
}
const mutationFile = {
  'dialog-root-scroll': sourceRoot + 'components/agent-work-mode.css',
  'dialog-body-height': sourceRoot + 'components/agent-work-mode.css',
  'dialog-footer-order': sourceRoot + 'components/AgentWorkModeSetup.tsx',
  'dialog-path-disclosure': sourceRoot + 'components/AgentWorkProjectAnchor.tsx',
  'dialog-menu-boundary': sourceRoot + 'components/LauncherAgentDevice.tsx',
  'dialog-device-tail': sourceRoot + 'components/SourceAgentTargetSetup.tsx',
  'dialog-device-scroll': 'packages/client-ui/src/components/SelectionField.tsx',
}
let importSequence = 0

async function runVerifier({ driftOracle = false } = {}) {
  const originalOracle = readFileSync(oracle, 'utf8')
  const output = []
  const logs = [vi.spyOn(console, 'log').mockImplementation(line => output.push(line)), vi.spyOn(console, 'error').mockImplementation(line => output.push(line))]
  const previousExitCode = process.exitCode
  let calls = 0
  spawnSync.mockReset()
  spawnSync.mockImplementation((_command, args, options) => {
    calls += 1
    const mutation = options.env.LAUNCHER_AFFORDANCE_MUTATION ?? null
    const file = mutation ? mutationFile[mutation] : null
    const family = file?.endsWith('.css') ? styles : sources
    const captureReceipt = {
      passed: !mutation,
      exitCode: mutation ? 1 : 0,
      sources,
      styles,
      mutation,
      mutationHits: mutation ? [{ file, original: family[file], compiled: 'compiled-' + mutation }] : [],
      ui: { failure: mutation ? { message: failureText[mutation] } : null },
    }
    writeFileSync(resolve(root, args[1], 'receipt.json'), JSON.stringify(captureReceipt))
    if (driftOracle && calls === 1) writeFileSync(oracle, originalOracle + '\n// controlled oracle drift\n')
    return { status: mutation ? 1 : 0, stdout: '', stderr: '' }
  })
  try {
    await import(/* @vite-ignore */ `../scripts/verify-launcher-device-dialog.mjs?test=${++importSequence}`)
    const report = output.map(line => { try { return JSON.parse(line) } catch { return null } }).find(Boolean)
    expect(report, 'verifier emits one machine-readable receipt').toBeTruthy()
    const receiptPath = resolve(root, report.receipt)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    rmSync(dirname(receiptPath), { recursive: true, force: true })
    return { receipt, options: spawnSync.mock.calls.map(call => call[2]) }
  } finally {
    writeFileSync(oracle, originalOracle)
    process.exitCode = previousExitCode
    for (const spy of logs) spy.mockRestore()
  }
}

it('bounds every capture subprocess and preserves a clean chain', async () => {
  const { receipt, options } = await runVerifier()
  expect(receipt.passed).toBe(true)
  expect(options.length).toBeGreaterThanOrEqual(7)
  for (const option of options) expect(option.timeout).toBeGreaterThanOrEqual(120_000)
})

it('rejects an oracle that changes during the verification chain', async () => {
  const { receipt } = await runVerifier({ driftOracle: true })
  expect(receipt.passed).toBe(false)
  expect(receipt.failure.message).toMatch(/oracle/i)
})

it('binds direct probe, fixture and alias inputs into the oracle manifest', () => {
  const script = readFileSync(verifier, 'utf8')
  for (const file of [
    'apps/desktop/scripts/probe-process.mjs',
    'packages/client-ui/scripts/radix-overlay-aliases.ts',
    'apps/desktop/scripts/fixtures/space-launcher/index.html',
    'apps/desktop/scripts/fixtures/launcher-launchpad/index.html',
    'apps/desktop/scripts/fixtures/launcher-launchpad/vitest.owning.config.mts',
    'apps/desktop/scripts/fixtures/bookmark-local-link/vitest.owning.config.mts',
    'apps/desktop/scripts/lib/fixture-values.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'packages/core/package.json',
    'packages/demand/package.json',
    'packages/layout/package.json',
    'packages/client-ui/package.json',
    'apps/host/package.json',
  ]) expect(script).toContain(`'${file}'`)
})
