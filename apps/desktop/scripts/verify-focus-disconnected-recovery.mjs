import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

assert.equal(process.argv[2], '--evidence')
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
const stop = 'apps/desktop/src/renderer/src/components/SessionStop.tsx'
const focus = 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
await verifyRendererSourceMutations({ name: 'focus-disconnected-recovery', evidenceRoot: evidence,
  owningConfig: 'apps/desktop/test/vitest.focus-disconnected-recovery.config.mts',
  tests: ['apps/desktop/test/focus-disconnected-recovery.test.tsx', 'apps/desktop/test/session-stop-timeout.test.ts'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', 'test/fixture-values.mjs', 'apps/desktop/test/vitest.mote-context.config.mts',
    stop, focus, 'apps/desktop/src/shared/session-stop-timeout.ts'],
  mutations: [
    { label: 'inactive-stop-must-release-observer', file: stop,
      before: 'if (!active) setRequest(null)', after: 'if (!active && !flight.current) setRequest(null)' },
    { label: 'late-stop-error-must-not-enter-later-request', file: stop,
      before: 'value === original ? { ...original, submitted: true, feedback: presentError(error) } : value',
      after: 'value ? { ...value, submitted: true, feedback: presentError(error) } : value' },
    { label: 'unconfirmed-stop-must-retain-continuation', file: stop,
      before: 'setRequest(value => value === original ? { ...original, submitted: true, feedback: presentError(error) } : value)', after: 'setRequest(null)' },
    { label: 'continue-must-retain-original-control', file: stop,
      before: 'await api.sessions.stop(control)', after: 'await api.sessions.stop(useAppStore.getState().sessions[0].control)' },
    { label: 'unknown-stop-must-not-advertise-cached-exit', file: stop,
      before: 'sameRun && !current?.runUnobserved', after: 'sameRun && true' },
    { label: 'unknown-placeless-must-not-advertise-cached-exit', file: focus,
      before: "placeless.runUnobserved ? 'The current Run state is unknown.'", after: "false ? 'The current Run state is unknown.'" }
  ]
})
// Unchanged Core owner qualification: exact Stop retirement/continuation and
// explicit reopen preserve original identities, native source and captured history.
const command = ['exec', 'vitest', 'run', 'packages/core/test/focus-exited-stop.test.ts', 'packages/core/test/stop-explicit-retry.test.ts',
  '--config', 'apps/desktop/test/vitest.focus-disconnected-core.config.mts', '--maxWorkers=1']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function coreInputs() {
  const files = new Map()
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile()) files.set(path, hash(await readFile(path)))
    }
  }
  await collect('packages/core/src')
  assert.ok(files.size > 0, 'Core source set must be nonempty')
  for (const path of ['packages/core/test/focus-exited-stop.test.ts', 'packages/core/test/stop-explicit-retry.test.ts',
    'packages/core/test/fixtures/retired-reopen.ts', 'packages/core/test/helpers/fixture-values.ts', 'test/fixture-values.mjs',
    'apps/desktop/test/vitest.focus-disconnected-core.config.mts', 'apps/desktop/test/vitest.mote-context.config.mts',
    'vitest.config.ts', 'tsconfig.base.json', 'package.json', 'packages/core/package.json', 'pnpm-lock.yaml',
    'apps/desktop/scripts/verify-focus-disconnected-recovery.mjs']) files.set(path, hash(await readFile(path)))
  return { node: process.version, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    packagesDiff: hash(execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'packages'])), files: Object.fromEntries([...files].sort(([a],[b]) => a.localeCompare(b))), command }
}
const before = await coreInputs()
if (process.env.AGENTMUX_FOCUS_CORE_OWNER_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_FOCUS_CORE_OWNER_RECEIPT), saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.passed, true); assert.deepEqual(saved.inputs, before); assert.deepEqual(saved.sourceAfter, before)
  const log = await readFile(resolve(path, '../core-owner.log'))
  assert.equal(hash(log), saved.logSHA256); assert.match(log.toString(), /Tests\s+[1-9]\d* passed/); assert.doesNotMatch(log.toString(), /Tests\s+[1-9]\d* failed/)
  console.log(JSON.stringify({ passed: true, coreExactEvidenceReused: path, evidence }))
  process.exit(0)
}
const result = await new Promise((resolve, reject) => {
  const child = spawn('pnpm', command, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  child.on('error', reject); child.on('close', code => resolve({ code, output }))
})
await writeFile(resolve(evidence, 'core-owner.log'), result.output)
assert.equal(result.code, 0, result.output)
assert.match(result.output, /Tests\s+[1-9]\d* passed/)
const after = await coreInputs(); assert.deepEqual(after, before, 'Core owner inputs stayed unchanged during qualification')
await writeFile(resolve(evidence, 'core-owner.json'), JSON.stringify({ passed: true, command: ['pnpm', ...command], inputs: before, sourceAfter: after, logSHA256: hash(result.output),
  boundary: 'Current Core public Stop/reopen implementation; isolated file/memory Store and native transcript with private transport. No actual user Session/Runtime or installed App controlled.' }, null, 2)+'\n')
console.log(JSON.stringify({ passed: true, evidence }))
