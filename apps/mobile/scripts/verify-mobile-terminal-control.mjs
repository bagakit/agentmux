import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, loadConfigFromFile } from 'vite'

const mobile = resolve(import.meta.dirname, '..'), repo = resolve(mobile, '../..')
const argument = process.argv.indexOf('--browser-space'), spaceId = Number(process.argv[argument + 1])
assert.ok(argument !== -1 && Number.isSafeInteger(spaceId) && spaceId > 0,
  'Pass --browser-space <id> for the one existing private browser TaskSpace; no additional profile or browser is created.')
const evidence = join(repo, '.tmp/agentmux-private-mobile-client/mobile-terminal/control')
await mkdir(evidence, { recursive: true })
const paths = ['apps/mobile/src/terminal/control.ts', 'apps/mobile/src/terminal/reader.ts', 'apps/mobile/src/terminal/MobileTerminalViewer.tsx',
  'apps/mobile/src/mobile.css', 'apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/connection/hosted-rpc.ts',
  'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-reader.test.ts', 'apps/mobile/test/terminal-browser-fixture.tsx',
  'apps/host/test/mobile-terminal-control.test.ts', 'apps/mobile/scripts/verify-mobile-terminal-control.mjs', 'apps/mobile/scripts/verify-mobile-terminal-rebind.mjs',
  'packages/client-ui/src/terminal/input.ts', 'packages/client-ui/src/terminal/live-output.ts', 'packages/client-ui/src/terminal/replay.ts',
  'apps/desktop/src/renderer/src/components/TerminalView.tsx', 'apps/desktop/src/renderer/src/lib/terminal-reveal.ts',
  'apps/desktop/test/terminal-reveal.test.ts', 'apps/mobile/vite.config.ts', 'apps/mobile/vitest.config.ts']
const dependencies = ['apps/host/src/host.ts', 'apps/host/src/private-access.ts', 'apps/host/src/device-authority.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-wire.ts', 'packages/core/src/public-rpc-http.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/terminal-continuation.ts',
  'apps/mobile/node_modules/@xterm/xterm/lib/xterm.mjs']
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async path => [path,
  createHash('sha256').update(await readFile(join(repo, path))).digest('hex')])))
const source = await hashes(paths), consumedSource = await hashes(dependencies)
const reuse = process.argv.includes('--reuse-control-proofs')
let previous, previousReceiptHash
if (reuse) {
  const bytes = await readFile(join(evidence, 'receipt.json'))
  previousReceiptHash = createHash('sha256').update(bytes).digest('hex')
  previous = JSON.parse(bytes)
  // Every mutated implementation/caller stays exact; only the known reader copy,
  // its literal assertion, touch hit width and this verifier may change.
  const changed = new Set(['apps/mobile/src/terminal/reader.ts', 'apps/mobile/test/terminal-reader.test.ts',
    'apps/mobile/src/mobile.css', 'apps/mobile/scripts/verify-mobile-terminal-control.mjs'])
  for (const path of paths.filter(path => !changed.has(path))) assert.equal(source[path], previous.source[path], 'Reuse requires exact mutated Source and callers')
  assert.deepEqual(consumedSource, previous.consumedSource)
  assert.equal(previous.sourceMutations.length, 8)
  await writeFile(join(evidence, 'previous-validated-receipt.json'), bytes)
}
const run = (config, files, cwd = mobile) => {
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...files],
    { cwd, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 })
  if (result.error) throw result.error
  return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const config = join(mobile, 'vitest.config.ts')
const tests = ['test/terminal-control.test.ts', 'test/terminal-reader.test.ts']
const baseline = run(config, tests)
await writeFile(join(evidence, 'green.log'), baseline.output)
assert.equal(baseline.exitCode, 0, baseline.output); assert.match(baseline.output, /22 passed/u)
const product = join(mobile, 'src/terminal/control.ts'), code = await readFile(product, 'utf8')
const staleStart = code.indexOf('        if (queue.length && queue[0]!.run.runId !== next.runId) {')
const staleEnd = code.indexOf('        owner = facts.identity; run = next;', staleStart)
assert.ok(staleStart >= 0 && staleEnd > staleStart)
const stale = code.slice(staleStart, staleEnd)
assert.ok(stale.includes('return false') && stale.includes('未发送输入'), 'Nonempty actual identity gate')
const guardStart = code.indexOf('      if (owner.getItem(key) !== persisted) {')
const guardEnd = code.indexOf('      const next = unresolved', guardStart)
assert.ok(guardStart >= 0 && guardEnd > guardStart)
const guard = code.slice(guardStart, guardEnd)
assert.ok(guard.includes('canPersist = false') && guard.includes('return'), 'Nonempty actual storage ownership gate')
const mutations = [
  { id: 'protocol-replies-bypass-user-origin', from: "source !== 'user' || ", to: '' },
  { id: 'unknown-receipt-auto-sends-next-input', from: "state.mode === 'control' && !unknown() && queue.length", to: "state.mode === 'control' && queue.length" },
  { id: 'old-run-queue-reenabled', from: stale, to: '' },
  { id: 'late-ack-overwrites-new-intent', from: guard, to: '' },
  { id: 'cold-intent-becomes-confirmed', from: "phase: 'unknown', message: '重启前的终端操作回执未确认", to: "phase: 'idle', message: '重启前的终端操作回执未确认" },
  { id: 'original-run-identity-replaced', from: 'expectedRun: intent.run, data: intent.data', to: "expectedRun: { runId: 'different-run' }, data: intent.data" }
]
const proofs = []
for (const mutation of mutations) {
  assert.equal(code.split(mutation.from).length, 2, `${mutation.id} selects one actual Source block`)
  if (reuse) {
    const log = await readFile(join(evidence, `${mutation.id}-red.log`), 'utf8')
    assert.match(log, /AssertionError/u); assert.ok(log.includes(`AMX_MOBILE_INPUT_MUTANT:${mutation.id}`))
    const original = previous.sourceMutations.find(value => value.id === mutation.id)
    assert.ok(original?.sourceBlockApplied && original.assertionRed)
    proofs.push({ ...original, reusedExactSource: true, previousReceiptHash, logSha256: createHash('sha256').update(log).digest('hex') })
    continue
  }
  const mutant = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(mutant, `import base from ${JSON.stringify(config)};const target=${JSON.stringify(product)},from=${JSON.stringify(mutation.from)},to=${JSON.stringify(mutation.to)};export default {...base,plugins:[{name:'terminal-control-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==target)return;if(code.split(from).length!==2)throw new Error('Actual Source block missing');console.info('AMX_MOBILE_INPUT_MUTANT:${mutation.id}');return code.replace(from,to)}},...base.plugins]};\n`)
  try {
    const red = run(mutant, ['test/terminal-control.test.ts'])
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    assert.notEqual(red.exitCode, 0); assert.match(red.output, /AssertionError/u)
    assert.ok(red.output.includes(`AMX_MOBILE_INPUT_MUTANT:${mutation.id}`))
    proofs.push({ id: mutation.id, assertionRed: true, sourceBlockApplied: true, exitCode: red.exitCode })
  } finally { await rm(mutant) }
}
const actual = run(join(repo, 'vitest.config.ts'), ['apps/host/test/mobile-terminal-control.test.ts'], repo)
await writeFile(join(evidence, 'actual-https-two-run.log'), actual.output)
assert.equal(actual.exitCode, 0, actual.output); assert.match(actual.output, /1 passed/u)
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(mobile, 'vite.config.ts'))
assert.ok(loaded)
const browserMutations = [
  { id: 'mounted-terminal-input-disconnected', target: join(mobile, 'src/terminal/MobileTerminalViewer.tsx'),
    from: '    const input = subscribeTerminalInput(canvas, (data, source) => {\n      if (selectedSession.current === agentSessionId) binding.send(data, source)\n    })', to: '    const input = { dispose() {} }' },
  { id: 'keyboard-opened-without-control-gesture', target: join(mobile, 'src/terminal/MobileTerminalViewer.tsx'),
    from: "const enabled = visible && connection.state === 'connected' && inputState.mode === 'control' && inputState.phase !== 'unknown'\n      && control.current === controls.current.get(agentSessionId ?? '') && control.current?.facts().mode === 'control' && control.current.facts().phase !== 'unknown'",
    to: "const enabled = visible && connection.state === 'connected' && inputState.phase !== 'unknown'" }
]
async function browser(mutation) {
  let applied = 0
  const plugins = mutation ? [{ name: 'mounted-terminal-input-mutant', enforce: 'pre', transform(body, id) {
    if (id.split('?')[0] !== mutation.target) return
    assert.equal(body.split(mutation.from).length, 2)
    applied += 1; return body.replace(mutation.from, mutation.to)
  } }, ...loaded.config.plugins] : loaded.config.plugins
  const server = await createServer({ ...loaded.config, configFile: false, root: mobile, cacheDir: join(evidence, 'vite-cache'),
    plugins, server: { host: '127.0.0.1', port: 4322, strictPort: true, hmr: false } })
  await server.listen()
  const output = join(evidence, `${mutation?.id ?? 'original'}-browser.json`)
  try {
    const script = `const task=await taskSpace(${spaceId}),page=task.page('p1');await page.goto('http://127.0.0.1:4322/test/terminal-browser.html');const result=await page.evaluate(async()=>{const fixture=await import('/test/terminal-browser-fixture.tsx');try{return await fixture.runControlBrowserProof()}catch(error){return {passed:false,error:error.stack,facts:fixture.probeFacts()}}});let passive;if(result.passed){await page.reload();passive=await page.evaluate(async()=>{const fixture=await import('/test/terminal-browser-fixture.tsx');try{return await fixture.runBrowserProof()}catch(error){return {passed:false,error:error.stack,facts:fixture.probeFacts()}}})};await(await import('node:fs/promises')).writeFile(${JSON.stringify(output)},JSON.stringify({control:result,passive}));console.log(JSON.stringify({control:result,passive}));`
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn('ego-browser', ['nodejs', '-e', script], { cwd: mobile, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', errors = ''
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Own browser command deadline')) }, 20_000)
      child.stdout.on('data', value => { out += String(value) }); child.stderr.on('data', value => { errors += String(value) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', status => { clearTimeout(timer); resolveResult({ status, out, errors }) })
    })
    await writeFile(join(evidence, `${mutation?.id ?? 'original'}-browser.log`), `${result.out}\n${result.errors}`)
    assert.equal(result.status, 0, result.errors)
    const observed = JSON.parse(await readFile(output, 'utf8'))
    if (mutation) {
      assert.ok(applied > 0); assert.equal(observed.control.passed, false, 'Actual mounted input mutation must fail')
      assert.match(observed.control.error, /AssertionError/u)
      proofs.push({ id: mutation.id, sourceBlockApplied: true, assertionRed: true, mountedBrowser: true })
    } else {
      assert.equal(observed.control.passed, true, observed.control.error); assert.equal(observed.control.cases.length, 3)
      assert.equal(observed.passive.passed, true, observed.passive.error); assert.equal(observed.passive.cases.length, 10)
    }
    return observed
  } finally { await server.close() }
}
let mounted
try {
  for (const mutation of browserMutations) {
    if (reuse) {
      const log = await readFile(join(evidence, `${mutation.id}-browser.json`))
      const result = JSON.parse(log)
      assert.equal(result.control.passed, false); assert.match(result.control.error, /AssertionError/u)
      const original = previous.sourceMutations.find(value => value.id === mutation.id)
      assert.ok(original?.mountedBrowser && original.sourceBlockApplied && original.assertionRed)
      proofs.push({ ...original, reusedExactSource: true, previousReceiptHash, logSha256: createHash('sha256').update(log).digest('hex') })
    } else await browser(mutation)
  }
  mounted = await browser()
} finally { await rm(join(evidence, 'vite-cache'), { recursive: true, force: true }) }
// Reuse the independently bounded lifecycle proof only for its exact consumed
// Source. Otherwise execute its real mounted cases and block mutations here.
const rebindPath = join(evidence, 'rebind/receipt.json')
const rebindSources = ['apps/mobile/src/terminal/control.ts', 'apps/mobile/src/terminal/MobileTerminalViewer.tsx',
  'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-browser-fixture.tsx',
  'apps/mobile/scripts/verify-mobile-terminal-rebind.mjs', 'packages/core/src/hosted-client.ts',
  'packages/client-ui/src/terminal/input.ts']
let rebind
try {
  rebind = JSON.parse(await readFile(rebindPath, 'utf8'))
  assert.deepEqual(Object.keys(rebind.source).sort(), [...rebindSources].sort())
  assert.deepEqual(await hashes(rebindSources), rebind.source)
} catch {
  const checked = spawnSync(process.execPath, [join(mobile, 'scripts/verify-mobile-terminal-rebind.mjs'), '--browser-space', String(spaceId)],
    { cwd: repo, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 })
  await writeFile(join(evidence, 'rebind.log'), `${checked.stdout}${checked.stderr}`)
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`)
  rebind = JSON.parse(await readFile(rebindPath, 'utf8'))
}
assert.equal(rebind.actualMountedCases.length, 3); assert.equal(rebind.sourceMutations.length, 4)
assert.equal(rebind.restoredGreen.actualMountedCases, 3); assert.equal(rebind.typecheckExitCode, 0)
const restored = run(config, tests)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.exitCode, 0, restored.output); assert.match(restored.output, /22 passed/u)
const strictConfig = join(evidence, 'tsconfig.json')
await writeFile(strictConfig, JSON.stringify({ extends: '../../../../apps/mobile/tsconfig.json', compilerOptions: {
  types: ['node', 'vitest/globals'], noEmit: true }, include: ['../../../../apps/mobile/src/terminal/**/*.ts',
  '../../../../apps/mobile/src/terminal/**/*.tsx', '../../../../apps/mobile/test/terminal-control.test.ts',
  '../../../../apps/mobile/test/terminal-reader.test.ts', '../../../../apps/mobile/test/terminal-browser-fixture.tsx',
  '../../../../apps/host/test/mobile-terminal-control.test.ts'] }, null, 2) + '\n')
const typed = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', strictConfig], {
  cwd: repo, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
await writeFile(join(evidence, 'typecheck.log'), `${typed.stdout ?? ''}${typed.stderr ?? ''}`)
assert.equal(typed.status, 0, `${typed.stdout}${typed.stderr}`)
const viewer = await readFile(join(mobile, 'src/terminal/MobileTerminalViewer.tsx'), 'utf8')
const app = await readFile(join(mobile, 'src/MobileApp.tsx'), 'utf8')
const desktop = await readFile(join(repo, 'apps/desktop/src/renderer/src/components/TerminalView.tsx'), 'utf8')
assert.ok(app.includes('<MobileTerminalViewer client={client}'))
assert.ok(viewer.includes('createMobileTerminalControl({ client, agentSessionId, report: state => {'))
assert.ok(viewer.includes('if (selectedSession.current === agentSessionId) binding.send(data, source)'))
assert.ok(desktop.includes("import { subscribeTerminalInput } from '@agentmux/client-ui/terminal/input'"))
assert.ok(desktop.includes('subscribeTerminalInput(terminal, (data, source) =>'))
assert.ok(mounted.passive.cases.some(value => value.name === 'actual-mobile-app-terminal-navigation'))
assert.deepEqual(await hashes(paths), source); assert.deepEqual(await hashes(dependencies), consumedSource)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.mobile-terminal-control.v1', checkedAt: new Date().toISOString(),
  verificationCommand: `node apps/mobile/scripts/verify-mobile-terminal-control.mjs --browser-space ${spaceId}`,
  browserInput: { spaceId, ownership: 'This feature goal owns the explicit private browser TaskSpace input; no other browser or profile is created or adopted.' },
  source, consumedSource, unitBehaviorCases: 22, actualHttpsTwoRunCases: 1, actualMountedCases: 16, sourceMutations: proofs,
  rebindSourceProof: rebind, restoredGreen: { exitCode: restored.exitCode, cases: 22 }, typecheckExitCode: typed.status,
  callers: ['MobileApp → actual mounted MobileTerminalViewer → original reader and explicit control',
    'Desktop TerminalView + MobileTerminalViewer → same shared input Source', 'Mobile reader/control → actual authenticated HTTPS → sole Host/Core → original ctxmux Attachment/Input/size'],
  limitations: ['Actual TLS device principal approval is controlled locally through original Authority; no actual OS approval dialog.',
    'Actual mounted Chromium/xterm plus two physical private Runs and original SDK/HTTPS are exercised separately.',
    'No actual iPhone/Android, phone system trust, native IME or physical device performance claim; those remain their owning tasks.'],
  actualPhoneAccepted: false }, null, 2) + '\n')
console.log('Mobile terminal: 22 narrow behaviors, authenticated HTTPS with two physical Runs, 16 mounted browser cases, 12 Source block mutants RED and restored GREEN.')
