import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/hook-durability/codex-claude-proof')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const paths = ['packages/core/src/managed-hook-runtime.ts', 'packages/core/src/providers/shared.ts',
  'packages/core/src/providers/claude.ts', 'packages/core/src/providers/claude-plugin.ts', 'packages/providers/src/claude/provider.ts', 'packages/providers/src/claude/native-activity.ts',
  'packages/core/src/providers/codex.ts', 'packages/providers/src/codex/provider.ts', 'packages/providers/src/codex/launch-hooks.ts',
  'packages/core/src/hook-server.ts', 'packages/core/dist/agentmux-hook.mjs',
  'packages/core/test/codex-claude-retained-hook.test.ts', 'packages/core/test/fixtures/codex-claude-retained-hook.py',
  'packages/core/test/vitest.codex-claude-retained-hook.config.mts', 'packages/core/scripts/verify-codex-claude-retained-hook.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const identities = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const original = await identities()
const receipt = join(evidence, 'native-cases.json')
const reportPath = join(evidence, 'native.vitest.json')
await writeFile(receipt, '[]\n', { mode: 0o600 })
let result
try {
  result = { ...(await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'packages/core/test/vitest.codex-claude-retained-hook.config.mts', '--reporter=json', `--outputFile=${reportPath}`], { cwd: root,
    env: { ...process.env, AGENTMUX_CODEX_CLAUDE_RECEIPT: receipt }, maxBuffer: 8 * 1024 * 1024 })), code: 0 }
} catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
const log = result.stdout + result.stderr
await writeFile(join(evidence, 'native.log'), log, { mode: 0o600 })
assert.deepEqual(await identities(), original, 'Native proof production inputs changed during qualification')
assert.equal(result.code, 0, log)
const report = JSON.parse(await readFile(reportPath, 'utf8'))
assert.equal(report.numTotalTests, 6); assert.equal(report.numPassedTests, 6); assert.equal(report.numFailedTests, 0)
const cases = JSON.parse(await readFile(receipt, 'utf8'))
assert.equal(cases.length, 6)
assert.deepEqual(cases.map(value => `${value.providerId}/${value.mode}`).sort(),
  ['claude/allow-once', 'claude/no-decision', 'claude/reject-once', 'codex/allow-once', 'codex/no-decision', 'codex/reject-once'])
assert(cases.every(value => value.privateSourceRemoved && value.childrenReaped && value.originalNativeSessionId))
assert(cases.every(value => value.permissionRequests === 1 && value.events.includes('PermissionRequest')))
assert(cases.filter(value => value.mode !== 'no-decision').every(value => value.decisionsReturned === 1))
assert(cases.filter(value => value.mode === 'allow-once').every(value => value.markerExecuted && value.events.includes('PostToolUse')))
assert(cases.filter(value => value.mode === 'reject-once').every(value => !value.markerExecuted && value.nativeToolFeedback.length > 0))
assert(cases.filter(value => value.mode === 'no-decision').every(value => value.nativeWaitPreserved && !value.markerExecuted && value.decisionsReturned === 0 && !value.events.includes('PostToolUse')))
assert(cases.filter(value => value.providerId === 'codex').every(value => value.nativeInspection.code === 'HOOK_NATIVE_CURRENT_AND_TRUSTED'))
await writeFile(join(evidence, 'positive.json'), JSON.stringify({ passed: true, productionAndTestSHA256: original,
  receiptSHA256: sha(await readFile(receipt)), nativeCases: cases.length,
  scope: 'Actual Provider launch carrier → native CLI → source-removed retained worker → authenticated HookServer; both Providers use their original native PermissionRequest callback for allow/reject and preserve native waiting without a decision. Core.createAgent/ctxmux and full desktop restart are separate gates.' }, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ passed: true, nativeCases: cases.length, evidence }) + '\n')
