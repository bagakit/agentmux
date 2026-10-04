import { probeDirectoryRuntime } from './fixtures/mote-directory-short-runtime/probe.mjs'
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const receipt = await probeDirectoryRuntime({ evidence: flag('--evidence-dir'), mainRef: flag('--main-ref') })
console.log(JSON.stringify({ passed: receipt.passed, mainRef: receipt.mainRef, hosts: receipt.phases.map(phase => phase.pid),
  originalRun: receipt.seed.run, survivingRun: receipt.restored.run, cleanup: receipt.cleanup }))
