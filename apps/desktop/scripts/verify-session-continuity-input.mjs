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
  ['launch-store-carrier', 'carries the first fresh recovery input once through actual Store recovery'],
  ['launch-live-receipt', 'settles the original lost reply through actual Core event projection'],
  ['launch-concurrent-records', 'preserves both original decisions under two FileStore clients'],
  ['launch-pending-freeze', 'does not replace a same-op frozen input when two pending observations race'],
  ['launch-early-freeze', 'retains the same frozen fresh input across an initial'],
  ['postlaunch-original-claim', 'does not replay a deferred claim when a second FileStore owner'],
  ['postlaunch-known-unknown', 'only inspects an existing unknown deferred input'],
  ['postlaunch-same-op', 'rejoins a committed unclaimed deferred packet'],
  ['postlaunch-lost-start', 'continues the original post-launch-only input after a lost Start ACK'],
  ['postlaunch-not-applied', 'projects only the original exact deferred refusal as not-applied'],
  ['launch-reconcile-history', 'reconciles an applied Start with lost ACK'],
  ['launch-mailbox-carrier', 'carrier through the real mailbox consumer'],
  ['launch-history-key', 'reads the original launch key through the real public RPC input.inspect wire'],
  ['launch-rpc-inspect', 'reads the original launch key through the real public RPC input.inspect wire'],
  ['launch-carrier', 'carries the original fresh input by the actual Provider resume argv contract'],
  ['launch-atomic-receipt', 'carries the original fresh input by the actual Provider resume argv contract'],
  ['launch-reconcile-operation', 'does not reconcile an unknown original launch to another lifecycle operation'],
  ['launch-frozen-source', 'under the original prepared input identity'],
  ['launch-record', 'carries the original fresh input by the actual Provider resume argv contract'],
  ['launch-reconcile-args', 'does not adopt different Runtime arguments'],
  ['launch-post-original-key', 'uses the original submission ID and real terminal owner'],
  ['selected-body', 'delivers frozen selected parts once'],
  ['optional-native-gate', 'retains the public first-prompt owner without optional native probes'],
  ['input-trigger', 'keeps input-trigger restoration free'],
  ['unknown-replay', 'never resends an unknown original input'],
  ['atomic-claim', 'does not dispatch twice when a stale second owner'],
  ['frozen-receipt', 'cannot use an actual different-body ACK'],
  ['latest-pointer', 'restores the exact frozen original phase after disposing'],
  ['handshake-credit', 'credits only the actual same-Run handshake'],
  ['new-user-priority', 'keeps a genuinely newer user prompt ahead'],
  ['native-target', 'does not send recovery input to a changed native conversation'],
  ['native-transport', 'preserves a declared negative native transport result'],
  ['observed-foreign-source', 'rejects a confirmed foreign process source while retaining'],
  ['observer-unknown-gate', 'source observation from revoking the original first-prompt contract'],
  ['native-idle', 'requires actual native idle evidence'],
  ['dispose-observer', 'does not wait for an unresponsive native observer'],
  ['live-projection', 'clears the original pending notice through actual Store Core event consumption'],
  ['persistent-notice', 'shows the actual mailbox notice']
]
const ownerFiles = ['packages/core/src/agent-session-recovery/input.ts', 'packages/core/src/agent-session-recovery/continuity.ts',
  'packages/core/src/client.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/prompt-submission-record.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/types.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/session-service-notices.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx', 'apps/desktop/src/renderer/src/lib/steer-queue-delivery.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts']
const fingerprint = async () => Object.fromEntries(await Promise.all(ownerFiles.map(async file => [file,
  createHash('sha256').update(await readFile(join(root, file))).digest('hex')])) )
await mkdir(evidence, { recursive: true })
const report = { schema: 'agentmux.session-continuity-input.v1', passed: false, source: await fingerprint(), runs: [],
  productChain: 'Native launch-capable Providers: Desktop fresh input/Core automatic recovery -> frozen original launch packet -> original Provider buildResumeLaunch -> Runtime start/lifecycle commit -> same SessionStore typed launch record -> actual Unix RPC input.inspect and original timeline key. Post-launch-only Providers and retained prior phases: Desktop/Mote typed recovery -> Main RuntimeController -> Core ensureAgentContinuity -> lifecycle+original SessionStore continuityOperations -> AgentSessionContinuityInputs -> actual submitAgentPrompt exact-condition -> original prompt owner/Runtime input -> original readPromptAdmission key -> shared part receipt. Main snapshots expose original operations; actual mounted AgentSessionComposer mailbox consumes persistent notices. Core fixtures execute both startup and mote-startup, native evidence, actual FileStore, byte ACKs, real client dispose/new owner and conflicting/new input. Real Electron restart and third process identity are independently exercised by verify-session-continuity-product.mjs.',
  boundary: 'A launch-carried receipt proves only Runtime start carried its frozen argv, never PTY or Native acceptance. Pending/unknown Start reconciles the original lifecycle and exact argument digest without restart. One combined input; selected parts share one physical delivery receipt. Terminal byte ACK is never model completion. Unknown writes are inspected only. Actual owner modules are mutated in isolated Vite transforms; shared Source and user Runtime are untouched.' }
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
        ...(pattern ? ['-t', pattern] : []), '--reporter=default', '--reporter=json', '--outputFile', output], { cwd: root,
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
