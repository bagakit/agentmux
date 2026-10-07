import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const evidence = resolve(process.argv[2] ?? join(root, '.tmp/session-continuity/input'))
const config = 'apps/desktop/test/session-continuity-input.config.mts'
const mutations = [
  ['selected-body', 'delivers frozen selected parts once'],
  ['input-trigger', 'keeps input-trigger restoration free'],
  ['unknown-replay', 'never resends an unknown original input'],
  ['atomic-claim', 'does not dispatch twice when a stale second owner'],
  ['frozen-receipt', 'cannot use an actual different-body ACK'],
  ['latest-pointer', 'restores the exact frozen original phase after disposing'],
  ['handshake-credit', 'credits only the actual same-Run handshake'],
  ['new-user-priority', 'keeps a genuinely newer user prompt ahead'],
  ['native-target', 'does not send recovery input to a changed native conversation'],
  ['native-idle', 'requires actual native idle evidence'],
  ['dispose-observer', 'does not wait for an unresponsive native observer'],
  ['live-projection', 'clears the original pending notice through actual Store Core event consumption'],
  ['persistent-notice', 'shows the actual mailbox notice']
]
const ownerFiles = ['packages/core/src/agent-session-continuity-input.ts', 'packages/core/src/agent-session-continuity.ts',
  'packages/core/src/client.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/agent-session-store.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/session-service-notices.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts']
const fingerprint = async () => Object.fromEntries(await Promise.all(ownerFiles.map(async file => [file,
  createHash('sha256').update(await readFile(join(root, file))).digest('hex')])) )
await mkdir(evidence, { recursive: true })
const report = { schema: 'agentmux.session-continuity-input.v1', passed: false, source: await fingerprint(), runs: [],
  productChain: 'Desktop/Mote typed recovery -> Main RuntimeController -> Core ensureAgentContinuity -> lifecycle+original SessionStore continuityOperations -> AgentSessionContinuityInputs -> actual submitAgentPrompt exact-condition -> original prompt owner/Runtime input -> original readPromptAdmission key -> shared part receipt. Main snapshots expose original operations; actual mounted AgentSessionComposer mailbox consumes persistent notices. Core fixtures execute both startup and mote-startup, native evidence, actual FileStore, byte ACKs, real client dispose/new owner and conflicting/new input. Real Electron restart and third process identity are independently exercised by verify-session-continuity-product.mjs.',
  boundary: 'One combined input; selected parts share one physical delivery receipt. Terminal byte ACK is never model completion. Unknown writes are inspected only. Actual owner modules are mutated in isolated Vite transforms; shared Source and user Runtime are untouched.' }
try {
  // A development run may reuse a current build while another isolated product fixture captures it.
  // Vitest retains the repository source/dist freshness guard in either case.
  if (!process.env.AGENTMUX_CONTINUITY_INPUT_REUSE_BUILD) {
    const build = await execute(process.execPath, ['packages/core/scripts/build.mjs'], { cwd: root,
      env: { ...process.env, pnpm_config_verify_deps_before_run: '' }, maxBuffer: 8 * 1024 * 1024 })
    await writeFile(join(evidence, 'build.log'), build.stdout + build.stderr)
  }
  for (const [variant, pattern] of [['current', ''], ...mutations]) {
    const output = join(evidence, variant + '.json')
    let code = 0, stdout = '', stderr = ''
    try {
      const result = await execute(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
        ...(pattern ? ['-t', pattern] : []), '--reporter=json', '--outputFile', output], { cwd: root,
        env: { ...process.env, ...(variant === 'current' ? {} : { AGENTMUX_CONTINUITY_INPUT_MUTATION: variant }) }, maxBuffer: 8 * 1024 * 1024 })
      stdout = result.stdout; stderr = result.stderr
    } catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
    await writeFile(join(evidence, variant + '.log'), stdout + stderr)
    const actual = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(actual.numTotalTests > 0, 'The original input consumer tests must actually be collected')
    if (variant === 'current') { assert.equal(code, 0, stdout + stderr); assert.equal(actual.numFailedTests, 0); assert.ok(actual.numPassedTests >= 20) }
    else {
      assert.notEqual(code, 0, 'Loaded source mutation must turn red: ' + variant)
      const failures = actual.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
      assert.ok(failures.some(test => test.fullName.includes(pattern)), 'The actual matching behavioral oracle must fail, rather than setup/compile/collection: ' + variant)
    }
    report.runs.push({ variant, passed: true, code, passedTests: actual.numPassedTests, failedTests: actual.numFailedTests })
    console.log(JSON.stringify(report.runs.at(-1)))
  }
  assert.deepEqual(await fingerprint(), report.source, 'The validated source snapshot must stay unchanged')
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure?.message })) }
