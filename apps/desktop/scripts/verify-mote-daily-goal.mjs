import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { probeGoalRuntime } from './fixtures/mote-daily-goal/runtime-probe.mjs'
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
if (process.argv.includes('--runtime-only')) {
  const receipt = await probeGoalRuntime({ repository: resolve(fileURLToPath(new URL('../../..', import.meta.url))), evidence: flag('--evidence-dir'), mainRef: flag('--main-ref') })
  console.log(JSON.stringify({ passed: receipt.passed, source: receipt.mainRef, phases: receipt.phases.map(phase => phase.pid) }))
} else {
  await import('./fixtures/mote-daily-goal/qualify-gate.mjs')
}
