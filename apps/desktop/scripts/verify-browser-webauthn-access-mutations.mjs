import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Vite consumes the real module's bytes with exactly one changed behavioral block.
// Its original module id keeps the real shared lease import and owning consumer.
const root = resolve(import.meta.dirname, '../../..')
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--evidence-root', '--only'].includes(key) && value && !value.startsWith('--') && !options.has(key), 'Expected unique --evidence-root or --only with a value')
  options.set(key, value)
}
const out = resolve(root, options.get('--evidence-root') ?? `docs/reviews/evidence/browser-orca-auth-borrowing-2026-10-04/access/mutations/attempt-${Date.now()}`)
mkdirSync(out, { recursive: true })
assert.equal(existsSync(join(out, 'receipt.json')), false, 'Never overwrite an existing mutation packet')
const sourcePath = 'apps/desktop/src/main/browser-webauthn-access.ts'
const testPath = 'apps/desktop/test/browser-webauthn-access.test.ts'
const configPath = 'apps/desktop/scripts/fixtures/browser-webauthn-accounts/vitest.owning.config.mts'
const original = readFileSync(join(root, sourcePath), 'utf8')
const sha = value => createHash('sha256').update(value).digest('hex')
const definitions = [
  { id: 'non-http-loopback', before: "    return url.protocol === 'https:' || (url.protocol === 'http:'\n      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))", after: "    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)", assertion: 'uses actual requesting securityOrigin' },
  { id: 'wrong-request-origin', before: "&& trustedOrigin(details.securityOrigin) && owned(session, created, contents)", after: "&& trustedOrigin(_origin) && owned(session, created, contents)", assertion: 'uses actual requesting securityOrigin' },
  { id: 'other-permission-allow', before: "permission === 'hid'\n      && trustedOrigin", after: "true\n      && trustedOrigin", assertion: 'denies every other permission' },
  { id: 'request-permission-allow', before: 'session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))', after: 'session.setPermissionRequestHandler((_contents, _permission, callback) => callback(true))', assertion: 'denies every other permission' },
  { id: 'non-fido-device-allow', before: "    session.setDevicePermissionHandler(details => details.deviceType === 'hid' && trustedOrigin(details.origin) && fidoDevice(details.device))", after: "    session.setDevicePermissionHandler(details => details.deviceType === 'hid' && trustedOrigin(details.origin))", assertion: 'device policy requires hid' },
  { id: 'non-fido-selection', before: '    const devices = details.deviceList.filter(fidoDevice)', after: '    const devices = details.deviceList.filter(() => true)', assertion: 'empty native list and non-FIDO list' },
  { id: 'single-second-approval', before: '    if (devices.length === 1) { complete(callback, devices[0]!.deviceId, owner); return }', after: '', assertion: 'continues the sole FIDO candidate' },
  { id: 'multiple-first-guessed', before: '    const originalOwner = owner', after: '    complete(callback, devices[0]!.deviceId, owner); return\n    const originalOwner = owner', assertion: 'multiple FIDO candidates use original' },
  { id: 'invalid-id-filtered', before: "    if (ids.some(id => typeof id !== 'string' || id.trim().length === 0) || new Set(ids).size !== ids.length) {\n      report(owner, '安全密钥选择已取消：浏览器提供的设备候选无效。')\n      complete(callback, null, owner)\n      return\n    }", after: '', assertion: 'insecure source, missing frame, malformed duplicate' },
  { id: 'background-cancel', before: '    const originalOwner = owner', after: '    if (!presentationBounds(owner)) { complete(callback, null, owner); return }\n    const originalOwner = owner', assertion: 'background and temporary hidden owner retain' },
  { id: 'force-owner-focus', before: '      const bounds = presentationBounds(originalOwner)', after: '      originalOwner.window.focus()\n      const bounds = presentationBounds(originalOwner)', assertion: 'background and temporary hidden owner retain' },
  { id: 'window-lease-removed', before: '      if (!bounds || !acquireBrowserWebAuthnWindowMenu(originalOwner.window, request!)) { waiting(); return }', after: '      if (!bounds) { waiting(); return }', assertion: 'foreign account-menu lease keeps' },
  { id: 'hidden-menu-not-closed', before: '          try { hiddenMenu.closePopup(originalOwner.window) } catch { /* Keep the original request pending. */ }', after: '', assertion: 'foreign account-menu lease keeps' },
  { id: 'owner-lifecycle-removed', before: 'contents.session !== session || !owner.isCurrent() || owner.window.isDestroyed()', after: 'contents.session !== session || owner.window.isDestroyed()', assertion: 'stale frame token, origin, ancestry or owner' },
  { id: 'frame-identity-removed', before: "    for (const original of frames) {\n      if (actual !== original.frame || actual.isDestroyed() || actual.detached || actual.frameTreeNodeId !== original.nodeId\n        || actual.frameToken !== original.token || actual.url !== original.url || actual.origin !== original.origin) return false\n      actual = actual.parent\n    }\n    return actual === null", after: '    return true', assertion: 'stale frame token, origin, ancestry or owner' },
  { id: 'navigation-block-removed', before: "      if (!event.isSameDocument && (event.isMainFrame || (event.frame && frames.some(original => original.nodeId === event.frame!.frameTreeNodeId)))) cancelChanged()", after: '      // mutated: original-frame and ancestor navigation no longer cancel', assertion: 'cross-document navigation of original frame or ancestor' },
  { id: 'callback-once-removed', before: '      if (settled) return\n      settled = true', after: '      settled = true', assertion: 'multiple FIDO candidates use original' },
  { id: 'removed-device-selected', before: "            if (!candidates.has(device.deviceId)) { finish(null, '所选安全密钥已移除，请重新发起认证。'); return }", after: '', assertion: 'removed devices cannot be selected' },
  { id: 'request-timeout-removed', before: "    timeout = setTimeout(() => finish(null, '安全密钥选择已超时。请在原页面重新发起认证。'), selectionTimeoutMs)", after: '    timeout = setTimeout(() => {}, selectionTimeoutMs)', assertion: 'timeout, destroyed contents, renderer crash' },
  { id: 'session-installed-again', before: '  if (!state) {', after: '  if (true) {', assertion: 'shared Session installs policies exactly once' },
  { id: 'last-policy-release-removed', before: '      session.setPermissionCheckHandler(null)\n      session.setPermissionRequestHandler(null)\n      session.setDevicePermissionHandler(null)', after: '', assertion: 'shared Session installs policies exactly once' },
  { id: 'mutable-device-candidates', before: '    const devices = details.deviceList.filter(fidoDevice).map((device, index) => ({\n      deviceId: device.deviceId,\n      label: label(device.name || `安全密钥 ${index + 1}`)\n    }))', after: '    const devices = details.deviceList.filter(fidoDevice).map((device, index) => ({\n      get deviceId() { return device.deviceId },\n      get label() { return label(device.name || `安全密钥 ${index + 1}`) }\n    }))', assertion: 'snapshots original device IDs and labels' }
]
const only = options.has('--only') ? options.get('--only').split(',') : null
if (only) assert.ok(only.length > 0 && new Set(only).size === only.length && only.every(id => definitions.some(row => row.id === id)), 'Every requested Source block must exist exactly once')
const selected = only ? definitions.filter(row => only.includes(row.id)) : definitions
assert.ok(selected.length > 0, 'The mutation set must be nonempty')
const scratch = mkdtempSync(join(tmpdir(), 'agentmux-webauthn-access-mutants-'))
const replacement = join(scratch, 'browser-webauthn-access.ts')
const config = join(scratch, 'vitest.config.mts')
writeFileSync(config, `import base from ${JSON.stringify(join(root, configPath))}\nimport { readFileSync, writeFileSync } from 'node:fs'\nimport { createHash } from 'node:crypto'\nexport default { ...base, test: { ...base.test, include: [${JSON.stringify(testPath)}] }, plugins: [{ name: 'actual-access-source-mutation', enforce: 'pre', load(id) { if (id.split('?')[0] !== ${JSON.stringify(join(root, sourcePath))}) return; const source = readFileSync(${JSON.stringify(replacement)}, 'utf8'); writeFileSync(process.env.AGENTMUX_ACCESS_LOADED_SOURCE, JSON.stringify({ origin: ${JSON.stringify(sourcePath)}, loadedPath: ${JSON.stringify(replacement)}, sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) }) + '\\n'); return source } }] }\n`)
const inputs = [sourcePath, testPath, configPath, 'apps/desktop/src/main/browser-webauthn-window-menu.ts']
  .map(path => { const bytes = readFileSync(join(root, path)); return { path, sha256: sha(bytes), bytes: bytes.length } })
const runs = []
let passed = false
function run(id, expectedSource) {
  const dir = join(out, id); mkdirSync(dir, { recursive: true })
  const loadedPath = join(dir, 'loaded-source.json')
  const reportPath = join(dir, 'report.json')
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], {
    cwd: root, env: { ...process.env, AGENTMUX_ACCESS_LOADED_SOURCE: loadedPath }, encoding: 'utf8', timeout: 60_000
  })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(join(dir, 'raw.log'), log)
  assert.equal(result.error, undefined, `Actual test process must finish: ${id}`)
  const loaded = JSON.parse(readFileSync(loadedPath, 'utf8'))
  assert.equal(loaded.origin, sourcePath); assert.equal(loaded.loadedPath, replacement)
  assert.ok(loaded.bytes > 0, 'Actual compiled Source bytes must be nonempty')
  assert.equal(loaded.sha256, sha(expectedSource), 'Vite must compile the exact changed/restored Source')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.ok(report.numTotalTests > 0 && report.testResults.length > 0, 'Actual owning test result collection must be nonempty')
  return { dir, exitCode: result.status, log, loaded, report }
}
try {
  writeFileSync(join(out, 'original-source.ts.source'), original)
  writeFileSync(replacement, original)
  const baseline = run('baseline', original)
  assert.equal(baseline.exitCode, 0, baseline.log)
  for (const definition of selected) {
    assert.ok(definition.before.length > 0)
    assert.equal(original.split(definition.before).length - 1, 1, `One actual Source block: ${definition.id}`)
    const changed = original.replace(definition.before, definition.after)
    writeFileSync(replacement, changed)
    const red = run(definition.id, changed)
    writeFileSync(join(red.dir, 'actual-mutated-source.ts.source'), changed)
    assert.notEqual(red.exitCode, 0, `Mutation survived: ${definition.id}`)
    const assertions = red.report.testResults.flatMap(row => row.assertionResults)
      .filter(row => row.status === 'failed' && row.fullName.includes(definition.assertion))
    assert.ok(assertions.length > 0, `Intended actual module consumer must fail: ${definition.id}`)
    assert.ok(assertions.some(row => row.failureMessages.some(message => /AssertionError:/.test(message))), `Intended Assertion must fail, not import/parse/infra: ${definition.id}`)
    writeFileSync(replacement, original)
    const restored = run(`${definition.id}-restored`, original)
    assert.equal(restored.exitCode, 0, restored.log)
    runs.push({ id: definition.id, originalSha256: sha(original), changedSha256: sha(changed), blockSha256: sha(definition.before), intendedAssertion: definition.assertion, failedAssertions: assertions.map(row => row.fullName), redExit: red.exitCode, restoredExit: restored.exitCode, restoredTests: restored.report.numPassedTests, loaded: red.loaded })
  }
  passed = true
} finally {
  const drift = inputs.flatMap(row => sha(readFileSync(join(root, row.path))) === row.sha256 ? [] : [{ path: row.path, beforeSha256: row.sha256, afterSha256: sha(readFileSync(join(root, row.path))) }])
  if (drift.length) passed = false
  rmSync(scratch, { recursive: true })
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-webauthn-access-source-mutations.v1', author: '/root/browser_surfaces', passed, nativePassed: false, taskComplete: false, scope: 'Actual access Source compiled with real shared lease and Session/event/callback owning tests; Electron boundary doubles, no hardware/platform/blocklist-bypass claim', inputs, drift, runs, scratchRoot: scratch, scratchRemoved: true }, null, 2) + '\n')
}
assert.equal(passed, true, 'Selected actual Source blocks must produce Assertion RED and restored nonempty GREEN without drift')
process.stdout.write(JSON.stringify({ passed, mutants: runs.length, evidenceRoot: out }) + '\n')
