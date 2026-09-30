import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--evidence-root' && process.argv[3] && !process.argv[3].startsWith('--')), 'Only --evidence-root with a value is supported')
const out = resolve(root, process.argv[3] ?? `docs/reviews/evidence/browser-orca-auth-borrowing-2026-10-04/accounts/manager-glue/attempt-${Date.now()}`)
mkdirSync(out, { recursive: true })
const sourcePath = 'apps/desktop/src/main/browser-view-manager.ts'
const testPath = 'apps/desktop/test/browser-webauthn-accounts.test.ts'
const configPath = 'apps/desktop/scripts/fixtures/browser-webauthn-accounts/vitest.owning.config.mts'
const original = readFileSync(join(root, sourcePath), 'utf8')
const before = '      const releaseAccess = registerBrowserWebAuthnAccess(session, resolveOwner)'
assert.equal(original.split(before).length - 1, 1, 'One nonempty actual BVM Session registration block')
const changed = original.replace(before, '      const releaseAccess = () => {}')
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = [sourcePath, testPath, configPath, 'apps/desktop/src/main/browser-webauthn-accounts.ts', 'apps/desktop/src/main/browser-webauthn-access.ts', 'apps/desktop/src/main/browser-webauthn-window-menu.ts']
  .map(path => { const bytes = readFileSync(join(root, path)); return { path, sha256: sha(bytes), bytes: bytes.length } })
const scratch = mkdtempSync(join(tmpdir(), 'agentmux-webauthn-manager-mutant-'))
const replacement = join(scratch, 'browser-view-manager.ts')
const config = join(scratch, 'vitest.config.mts')
writeFileSync(config, `import base from ${JSON.stringify(join(root, configPath))}\nimport { readFileSync, writeFileSync } from 'node:fs'\nimport { createHash } from 'node:crypto'\nexport default { ...base, test: { ...base.test, include: [${JSON.stringify(testPath)}] }, plugins: [{ name: 'actual-bvm-registration-mutation', enforce: 'pre', load(id) { if (id.split('?')[0] !== ${JSON.stringify(join(root, sourcePath))}) return; const source = readFileSync(${JSON.stringify(replacement)}, 'utf8'); writeFileSync(process.env.AGENTMUX_MANAGER_LOADED_SOURCE, JSON.stringify({ origin: ${JSON.stringify(sourcePath)}, loadedPath: ${JSON.stringify(replacement)}, sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) }) + '\\n'); return source } }] }\n`)
const runs = []
let passed = false
function run(id, source) {
  const dir = join(out, id); mkdirSync(dir, { recursive: true })
  const loadedPath = join(dir, 'loaded-source.json')
  writeFileSync(replacement, source)
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, '--maxWorkers=1'], {
    cwd: root, env: { ...process.env, AGENTMUX_MANAGER_LOADED_SOURCE: loadedPath }, encoding: 'utf8', timeout: 60_000
  })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(join(dir, 'raw.log'), log)
  assert.equal(result.error, undefined, `Actual owning process completed: ${id}`)
  const loaded = JSON.parse(readFileSync(loadedPath, 'utf8'))
  assert.equal(loaded.origin, sourcePath)
  assert.equal(loaded.loadedPath, replacement)
  assert.ok(loaded.bytes > 0, 'Actual BVM loaded Source must be nonempty')
  assert.equal(loaded.sha256, sha(source), 'Vite must compile the actual original/changed BVM Source bytes')
  return { exitCode: result.status, log, loaded }
}
try {
  writeFileSync(join(out, 'original-source.ts'), original)
  writeFileSync(join(out, 'actual-mutated-source.ts'), changed)
  const baseline = run('baseline', original)
  assert.equal(baseline.exitCode, 0, baseline.log)
  const red = run('disconnect-access', changed)
  assert.notEqual(red.exitCode, 0, 'Disconnecting product Session registration must be RED')
  assert.match(red.log, /AssertionError:/, 'Registration failure must be a semantic assertion, not an import or parser failure')
  const failure = red.log.split('\n').find(line => /^ FAIL\s/.test(line) && line.includes(testPath) && line.includes('真实 BrowserViewManager.create → Session event → hide/resume/close'))
  assert.ok(failure, 'Actual BVM consumer must fail, not merely appear as a passed name')
  const restored = run('restored', original)
  assert.equal(restored.exitCode, 0, restored.log)
  runs.push({ id: 'disconnect-access', originalSha256: sha(original), changedSha256: sha(changed), blockSha256: sha(before), redExit: red.exitCode, restoredExit: restored.exitCode, actualFailureHeading: failure, loaded: red.loaded })
  passed = true
} finally {
  const drift = inputs.flatMap(row => sha(readFileSync(join(root, row.path))) === row.sha256 ? [] : [{ path: row.path, beforeSha256: row.sha256, afterSha256: sha(readFileSync(join(root, row.path))) }])
  if (drift.length) passed = false
  rmSync(scratch, { recursive: true })
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-webauthn-manager-source-mutation.v1', author: '/root/browser_input_history_main', passed, nativePassed: false, taskComplete: false, scope: 'One actual product BVM registerAccess block changed before Vite compilation; Electron boundary is a Source double', inputs, drift, runs, scratchRoot: scratch, scratchRemoved: true }, null, 2) + '\n')
}
assert.equal(passed, true, 'Registration block must fail its actual consumer, restore GREEN, and retain input identities')
process.stdout.write(JSON.stringify({ passed, mutants: runs.length, evidenceRoot: out }) + '\n')
