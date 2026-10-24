import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = resolve(process.env.AGENTMUX_PMO_CONTEXT_EVIDENCE_ROOT ?? join(root, '.tmp/pmo-startup-context'))
const regression = ['apps/desktop/test/demand-pmo-tab-context.test.ts', 'apps/desktop/test/first-execution-ipc.test.ts']
await mkdir(evidenceRoot, { recursive: true })
const resultPath = join(evidenceRoot, 'regression.json')
let failure, output = ''
try {
  const result = await promisify(execFile)('pnpm', ['exec', 'vitest', 'run', ...regression, '--maxWorkers=1',
    '--reporter=json', '--outputFile=' + resultPath], { cwd: root,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, maxBuffer: 8 * 1024 * 1024 })
  output = result.stdout + result.stderr
} catch (error) { failure = error; output = (error.stdout ?? '') + (error.stderr ?? '') }
await writeFile(join(evidenceRoot, 'regression.log'), output)
assert.equal(failure, undefined, output)
const result = JSON.parse(await readFile(resultPath, 'utf8'))
assert.ok(result.numPassedTests > 0 && result.numFailedTests === 0 && (result.numRuntimeErrorTestSuites ?? 0) === 0)

const store = 'apps/desktop/src/renderer/src/store.ts'
await verifyRendererSourceMutations({
  name: 'pmo-startup-context-mutations', evidenceRoot,
  tests: ['apps/desktop/test/goal-role-inputs.test.ts'],
  sources: [store, 'apps/desktop/scripts/verify-pmo-startup-context.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/src/main/scratch-topics.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/host/src/goal-role-input.ts', 'apps/desktop/src/main/runtime-controller.ts',
    'apps/desktop/src/shared/scratch-topics.ts', 'apps/desktop/src/shared/topic-agent-instructions.ts',
    'apps/desktop/test/helpers/injected-context-core.ts', 'apps/desktop/test/helpers/isolate-core-environment.ts',
    'apps/desktop/test/helpers/local-runtime-connector.ts', 'test/fixture-values.mjs',
    'packages/core/dist/goal-role-guidance.js', 'packages/core/dist/generated/agentmux-guides.js'],
  mutations: [
    { label: 'fresh-pmo-repeats-mote-role', file: store,
      before: '      ...(!fresh ? [MOTE_COORDINATION_ROLE] : []),',
      after: '      MOTE_COORDINATION_ROLE,' },
    { label: 'reused-pmo-repeats-manager-role', file: store,
      before: "      ...(fresh ? [goalRoleGuidance({ role: 'manager', goalId: demandId, source: { kind: 'goal-pmo-launch', ...(intent.creationOperationId ? { operationId: intent.creationOperationId } : {}) } })] : []),",
      after: "      goalRoleGuidance({ role: 'manager', goalId: demandId, source: { kind: fresh ? 'goal-pmo-launch' : 'goal-discussion', ...(intent.creationOperationId ? { operationId: intent.creationOperationId } : {}) } })," }
  ]
})
console.log(JSON.stringify({ passed: true, regression: resultPath, tests: result.numPassedTests,
  boundary: 'Real PMO producers, registered IPC and Core/FileStore; private Native I/O only; no live Agent input or installed-app claim.' }))
