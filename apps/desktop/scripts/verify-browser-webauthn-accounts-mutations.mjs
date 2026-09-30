import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Only the real account module is replaced before Vite compiles it. The test keeps
// importing the product BVM/Session consumer; no repository copy or Native launch.
const root = resolve(import.meta.dirname, '../../..')
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--evidence-root', '--only'].includes(key) && value && !value.startsWith('--') && !options.has(key), 'Expected unique --evidence-root or --only with a value')
  options.set(key, value)
}
const out = resolve(root, options.get('--evidence-root') ?? `docs/reviews/evidence/browser-orca-auth-borrowing-2026-10-04/accounts/mutations/attempt-${Date.now()}`)
mkdirSync(out, { recursive: true })
const sourcePath = 'apps/desktop/src/main/browser-webauthn-accounts.ts'
const testPath = 'apps/desktop/test/browser-webauthn-accounts.test.ts'
const configPath = 'apps/desktop/scripts/fixtures/browser-webauthn-accounts/vitest.owning.config.mts'
const original = readFileSync(join(root, sourcePath), 'utf8')
const sha = value => createHash('sha256').update(value).digest('hex')
const definitions = [
  { id: 'single-second-approval', before: "    if (accounts.length === 1) {\n      // The authenticator already supplied the only account. Its user verification\n      // remains separate; continue this exact native request without a second approval.\n      complete(callback, accounts[0]!.credentialId, owner)\n      return\n    }", after: '', assertion: '单合法账户 visible 直接继续同一原请求' },
  { id: 'invalid-candidate-filter', before: "    if (credentialIds.some(id => typeof id !== 'string' || id.trim().length === 0)\n      || new Set(credentialIds).size !== credentialIds.length) {\n      report(owner, '账户选择已取消：浏览器提供的账户候选无效。请在原页面重新发起认证。')\n      complete(callback, null, owner)\n      return\n    }", after: '', assertion: '非法候选不删除后猜单个账户' },
  { id: 'background-cancels-request', before: '    const originalOwner = owner', after: '    if (!presentationBounds(owner)) { complete(callback, null, owner); return }\n    const originalOwner = owner', assertion: '保留 pending，原 owner 恢复后只弹一次' },
  { id: 'stale-display-bounds', before: '    return { ...bounds }', after: '    return { x: 40, y: 70, width: 400, height: 200 }', assertion: '用当前 bounds 且不抢焦点' },
  { id: 'unfocused-popup', before: ' || (requireFocus && !owner.window.isFocused())', after: '', assertion: 'unfocused 保留 pending' },
  { id: 'focus-the-owner', before: '      const bounds = presentationBounds(originalOwner)', after: '      originalOwner.window.focus()\n      const bounds = presentationBounds(originalOwner)', assertion: '用当前 bounds 且不抢焦点' },
  { id: 'repeat-opened-menu', before: '        if (presentationBounds(originalOwner, false)) return', after: '', assertion: '菜单自己的窗口 blur 不取消用户选择' },
  { id: 'hide-leaves-menu-open', before: '        try { hiddenMenu.closePopup(originalOwner.window) } catch { /* Keep the original request pending. */ }', after: '', assertion: '原生 dismiss 保留原请求' },
  { id: 'owner-lifecycle-guard', before: " || !owner.isCurrent()", after: '', assertion: '回点重验 owner' },
  { id: 'original-navigation', before: '      if (navigation.isMainFrame || (navigation.frame && frames.some((original) => original.nodeId === navigation.frame!.frameTreeNodeId))) cancelChanged()', after: '      // mutated: original and ancestor navigation no longer end the pending request', assertion: '导航即使同 URL 也取消' },
  { id: 'frame-document-identity', before: "        || current.frameToken !== original.token || current.url !== original.url || current.origin !== original.origin", after: '', assertion: '回点重验 token' },
  { id: 'original-frame-contents', before: '    if (!frame || webContents.fromFrame(frame) !== contents) return false', after: '    if (!frame) return false', assertion: '回点重验 from-frame' },
  { id: 'callback-exact-once', before: '      if (settled) return\n      settled = true', after: '      settled = true', assertion: 'close 只取消一次' },
  { id: 'finish-timers', before: '      if (timeout) clearTimeout(timeout)\n      if (validityCheck) clearInterval(validityCheck)', after: '', assertion: 'close 只取消一次' },
  { id: 'hidden-dismiss', before: '          if (!presentationBounds(originalOwner, false)) {\n            menu = undefined\n            releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)\n            waitForOwner()\n            return\n          }', after: '', assertion: '原生 dismiss callback 先于窗口事件也保留原请求' },
  { id: 'stale-menu-dismiss', before: '          if (settled || menu !== displayedMenu) return', after: '          if (settled) return', assertion: '旧菜单回调不结束恢复后的选择' },
  { id: 'multiple-guessed-first', before: '    const originalOwner = owner', after: '    complete(callback, accounts[0]!.credentialId, owner); return\n    const originalOwner = owner', assertion: '多账户只回传用户点中的原凭据' },
  { id: 'unregister-pending', before: '    for (const pending of [...originalRegistration.pending]) pending.finish(null, unavailableMessage)', after: '', assertion: '后台等待期间 unregister 真正收尾' },
  { id: 'callback-reentry', before: "    if (windowRequests.has(owner.window)) {\n      report(owner, '此窗口已开始新的账户选择。请完成或取消该选择后重新发起认证。')\n      complete(callback, null, owner)\n      return\n    }", after: '', assertion: '不同 window 选择独立，原 callback 重入也不覆盖悬挂请求' },
  { id: 'window-menu-acquire', before: '      if (!acquireBrowserWebAuthnWindowMenu(originalOwner.window, request!)) { waitForOwner(); return }', after: '', assertion: '两认证事件在同窗口轮流呈现' },
  { id: 'window-menu-release-finish', before: '      settled = true\n      releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)', after: '      settled = true', assertion: 'foreign token 阻止账户菜单' },
  { id: 'window-menu-release-hidden', before: '        const hiddenMenu = menu\n        menu = undefined\n        releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)', after: '        const hiddenMenu = menu\n        menu = undefined', assertion: '原生 dismiss 保留原请求' },
  { id: 'window-menu-release-native-dismiss', before: '            menu = undefined\n            releaseBrowserWebAuthnWindowMenu(originalOwner.window, request!)', after: '            menu = undefined', assertion: '原生 dismiss callback 先于窗口事件也保留原请求' }
]
const only = options.has('--only') ? options.get('--only').split(',') : null
if (only) assert.ok(only.length > 0 && new Set(only).size === only.length && only.every(id => definitions.some(row => row.id === id)), 'Every requested mutation must exist exactly once')
const selected = only ? definitions.filter(row => only.includes(row.id)) : definitions
assert.ok(selected.length > 0, 'An actual Source mutation must be selected')
const scratch = mkdtempSync(join(tmpdir(), 'agentmux-webauthn-accounts-mutants-'))
const replacement = join(scratch, 'browser-webauthn-accounts.ts')
const config = join(scratch, 'vitest.config.mts')
writeFileSync(config, `import base from ${JSON.stringify(join(root, configPath))}\nimport { readFileSync, writeFileSync } from 'node:fs'\nimport { createHash } from 'node:crypto'\nexport default { ...base, test: { ...base.test, include: [${JSON.stringify(testPath)}] }, plugins: [{ name: 'actual-account-source-mutation', enforce: 'pre', load(id) { if (id.split('?')[0] !== ${JSON.stringify(join(root, sourcePath))}) return; const source = readFileSync(${JSON.stringify(replacement)}, 'utf8'); writeFileSync(process.env.AGENTMUX_ACCOUNT_LOADED_SOURCE, JSON.stringify({ origin: ${JSON.stringify(sourcePath)}, loadedPath: ${JSON.stringify(replacement)}, sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) }) + '\\n'); return source } }] }\n`)
const inputs = [sourcePath, testPath, configPath, 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-webauthn-access.ts', 'apps/desktop/src/main/browser-webauthn-window-menu.ts']
  .map(path => { const bytes = readFileSync(join(root, path)); return { path, sha256: sha(bytes), bytes: bytes.length } })
const runs = []
let passed = false
function run(id, expectedSource) {
  const dir = join(out, id); mkdirSync(dir, { recursive: true })
  const loadedPath = join(dir, 'loaded-source.json')
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, '--maxWorkers=1'], {
    cwd: root, env: { ...process.env, AGENTMUX_ACCOUNT_LOADED_SOURCE: loadedPath }, encoding: 'utf8', timeout: 60_000
  })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(join(dir, 'raw.log'), log)
  assert.equal(result.error, undefined, `Test process must actually complete: ${id}`)
  const loaded = JSON.parse(readFileSync(loadedPath, 'utf8'))
  assert.equal(loaded.origin, sourcePath)
  assert.equal(loaded.loadedPath, replacement)
  assert.ok(loaded.bytes > 0, 'The actual compiled Source collection is nonempty')
  assert.equal(loaded.sha256, sha(expectedSource), 'Vite must compile these exact replacement Source bytes')
  return { dir, exitCode: result.status, log, loaded }
}
try {
  writeFileSync(join(out, 'original-source.ts'), original)
  writeFileSync(replacement, original)
  const baseline = run('baseline', original)
  assert.equal(baseline.exitCode, 0, baseline.log)
  for (const definition of selected) {
    assert.equal(original.split(definition.before).length - 1, 1, `One nonempty actual Source block: ${definition.id}`)
    const changed = original.replace(definition.before, definition.after)
    writeFileSync(replacement, changed)
    const red = run(definition.id, changed)
    writeFileSync(join(red.dir, 'actual-mutated-source.ts'), changed)
    assert.notEqual(red.exitCode, 0, `Mutation survived: ${definition.id}`)
    assert.match(red.log, /AssertionError:/, `Actual semantic Assertion must fail, not parsing/import: ${definition.id}`)
    assert.ok(red.log.split('\n').some(line => /^ FAIL\s/.test(line) && line.includes(testPath) && line.includes(definition.assertion)), `Intended actual product consumer must fail: ${definition.id}`)
    writeFileSync(replacement, original)
    const restored = run(`${definition.id}-restored`, original)
    assert.equal(restored.exitCode, 0, restored.log)
    runs.push({ id: definition.id, path: sourcePath, originalSha256: sha(original), changedSha256: sha(changed), blockSha256: sha(definition.before), intendedAssertion: definition.assertion, redExit: red.exitCode, restoredExit: restored.exitCode, loaded: red.loaded })
  }
  passed = true
} finally {
  const drift = inputs.flatMap(row => sha(readFileSync(join(root, row.path))) === row.sha256 ? [] : [{ path: row.path, beforeSha256: row.sha256, afterSha256: sha(readFileSync(join(root, row.path))) }])
  if (drift.length) passed = false
  rmSync(scratch, { recursive: true })
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-webauthn-accounts-source-mutations.v1', author: '/root/browser_input_history_main', passed, nativePassed: false, taskComplete: false, scope: 'Actual account Source compiled before owning tests, real BVM consumer with fake Electron boundary; no Native/system credential claim', inputs, drift, runs, scratchRoot: scratch, scratchRemoved: true }, null, 2) + '\n')
}
assert.equal(passed, true, 'All selected Source assertions must be RED and restored GREEN without input drift')
process.stdout.write(JSON.stringify({ passed, mutants: runs.length, evidenceRoot: out }) + '\n')
