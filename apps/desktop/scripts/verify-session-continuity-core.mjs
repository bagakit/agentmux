import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const evidence = resolve(process.argv[2] ?? join(root, '.tmp/session-continuity/core'))
const config = 'apps/desktop/test/session-continuity-core.config.mts'
const selection = 'Agent Session continuity decision|Core-owned|并发恢复|lifecycle-busy|重启恢复|actual Store cold start'
const mutations = [
  ['working-gate', 'automatically restores interrupted working'],
  ['unknown-missing', 'preserves unknown observation'],
  ['expected-run', 'fences the exact expected Run'],
  ['healthy-resume', 'keeps a healthy Run attach-only'],
  ['atomic-receipt', 'commits the original operation and new Run atomically'],
  ['committed-health', 'keeps the legally committed new Run usable'],
  ['parked-rejoin', 'lets a genuinely new startup policy act'],
  ['ended-fresh-input', 'restores parked interrupted working for the first new manual input'],
  ['startup-trigger', 'submits every saved ended/working candidate']
]
const ownerFiles = ['packages/core/src/agent-session-recovery/continuity.ts', 'packages/core/src/client.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/agent-session-registry.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/mote-session-recovery.ts']
const fingerprint = async () => Object.fromEntries(await Promise.all(ownerFiles.map(async file => [file,
  createHash('sha256').update(await readFile(join(root, file))).digest('hex')])) )
await mkdir(evidence, { recursive: true })
const report = { schema: 'agentmux.session-continuity-core.v1', passed: false, source: await fingerprint(), runs: [],
  productChain: 'Desktop Store initialize/recoverSession -> preload sessions.recover -> IPC -> RuntimeController.recoverSession -> Hosted ensureAgentContinuity -> Core/AgentSessionStore; Mote submits the same typed trigger. Core and Agent inspection expose Session continuity receipts. Store consumer fixtures execute real startup and consume actual Core admission; real Electron/native identity restart is independently verified by verify-session-continuity-product.mjs.',
  boundary: 'Loads and mutates actual production owner modules in isolated Vite transforms. Never edits shared Source, starts user Runs or replays unknown input. Existing unrelated prompt screen-evidence tests remain outside this continuity policy gate.' }
try {
  const build = await execute(process.execPath, ['packages/core/scripts/build.mjs'], { cwd: root,
    env: { ...process.env, pnpm_config_verify_deps_before_run: '' }, maxBuffer: 8 * 1024 * 1024 })
  await writeFile(join(evidence, 'build.log'), build.stdout + build.stderr)
  for (const [variant, pattern] of [['current', selection], ...mutations]) {
    const output = join(evidence, variant + '.json')
    let code = 0, stdout = '', stderr = ''
    try {
      const result = await execute(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '-t', pattern,
        '--reporter=json', '--outputFile', output], { cwd: root, env: { ...process.env,
          ...(variant === 'current' ? {} : { AGENTMUX_CONTINUITY_MUTATION: variant }) }, maxBuffer: 8 * 1024 * 1024 })
      stdout = result.stdout; stderr = result.stderr
    } catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
    await writeFile(join(evidence, variant + '.log'), stdout + stderr)
    const actual = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(actual.numTotalTests > 0, 'The actual consumer tests must be collected')
    if (variant === 'current') { assert.equal(code, 0, stdout + stderr); assert.equal(actual.numFailedTests, 0); assert.ok(actual.numPassedTests >= 20) }
    else {
      assert.notEqual(code, 0, 'The loaded implementation mutation must turn red: ' + variant)
      const failures = actual.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
      assert.ok(failures.length > 0, 'Mutation must fail a behavioral assertion')
      assert.ok(failures.some(test => test.fullName.includes(pattern)), 'Mutation must break its exact load-bearing behavioral oracle')
    }
    report.runs.push({ variant, passed: true, code, passedTests: actual.numPassedTests, failedTests: actual.numFailedTests })
    console.log(JSON.stringify(report.runs.at(-1)))
  }
  assert.deepEqual(await fingerprint(), report.source, 'Owner Source must remain unchanged through validation')
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure?.message })) }
