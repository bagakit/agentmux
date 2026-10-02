import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, loadConfigFromFile } from 'vite'

const mobile = resolve(import.meta.dirname, '..'), repo = resolve(mobile, '../..')
const flag = process.argv.indexOf('--browser-space'), spaceId = Number(process.argv[flag + 1])
assert.ok(flag >= 0 && Number.isSafeInteger(spaceId) && spaceId > 0, 'Use this feature goal’s existing private browser TaskSpace.')
const evidence = join(repo, '.tmp/agentmux-private-mobile-client/mobile-terminal/control/rebind')
await mkdir(evidence, { recursive: true })
const paths = ['apps/mobile/src/terminal/control.ts', 'apps/mobile/src/terminal/MobileTerminalViewer.tsx',
  'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-browser-fixture.tsx',
  'apps/mobile/scripts/verify-mobile-terminal-rebind.mjs', 'packages/core/src/hosted-client.ts',
  'packages/client-ui/src/terminal/input.ts']
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path,
  createHash('sha256').update(await readFile(join(repo, path))).digest('hex')])))
const source = await hashes()
const unit = () => spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
  join(mobile, 'vitest.config.ts'), 'test/terminal-control.test.ts', '-t', 'rebinds'], { cwd: mobile, encoding: 'utf8' })
const green = unit(); await writeFile(join(evidence, 'green.log'), `${green.stdout}${green.stderr}`)
assert.equal(green.status, 0, green.stderr); assert.match(green.stdout, /3 passed/u)
const viewer = await readFile(join(mobile, 'src/terminal/MobileTerminalViewer.tsx'), 'utf8')
const control = await readFile(join(mobile, 'src/terminal/control.ts'), 'utf8')
const ownerStart = control.indexOf('        if ((queue.length || unresolved) && !sameOwner(facts.identity)) {')
const ownerEnd = control.indexOf('        if (queue.length && queue[0]!', ownerStart)
assert.ok(ownerStart >= 0 && ownerEnd > ownerStart)
const owner = control.slice(ownerStart, ownerEnd)
assert.ok(owner.includes('return false') && owner.includes('另一 Host'), 'Actual nonempty semantic owner admission block')
const mutations = [
  { id: 'same-page-intent-owner-recreated', target: 'src/terminal/MobileTerminalViewer.tsx',
    from: '    let binding = controls.current.get(agentSessionId)', to: '    let binding: ReturnType<typeof createMobileTerminalControl> | undefined = undefined' },
  { id: 'previous-session-ACK-changes-selected-controls', target: 'src/terminal/MobileTerminalViewer.tsx',
    from: 'if (selectedSession.current === agentSessionId) setInputState(state)', to: 'setInputState(state)' },
  { id: 'another-runtime-input-owner-admitted', target: 'src/terminal/control.ts', from: owner, to: '' }
  , { id: 'keyboard-admitted-without-selected-intent-owner', target: 'src/terminal/MobileTerminalViewer.tsx',
    from: "const enabled = visible && connection.state === 'connected' && inputState.mode === 'control' && inputState.phase !== 'unknown'\n      && control.current === controls.current.get(agentSessionId ?? '') && control.current?.facts().mode === 'control' && control.current.facts().phase !== 'unknown'",
    to: 'const enabled = true' }
]
for (const mutation of mutations) assert.equal((mutation.target.includes('Viewer') ? viewer : control).split(mutation.from).length, 2)
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(mobile, 'vite.config.ts'))
assert.ok(loaded)
async function browser(mutation) {
  let applied = 0
  const plugins = mutation ? [{ name: 'same-page-intent-source-mutant', enforce: 'pre', transform(body, id) {
    if (id.split('?')[0] !== join(mobile, mutation.target)) return
    assert.equal(body.split(mutation.from).length, 2); applied += 1; return body.replace(mutation.from, mutation.to)
  } }, ...loaded.config.plugins] : loaded.config.plugins
  const server = await createServer({ ...loaded.config, configFile: false, root: mobile,
    cacheDir: join(evidence, 'vite-cache'), plugins, server: { host: '127.0.0.1', port: 4322, strictPort: true, hmr: false } })
  await server.listen()
  const id = mutation?.id ?? 'original', output = join(evidence, `${id}.json`)
  try {
    const script = `const task=await taskSpace(${spaceId}),page=task.page('p1');await page.goto('http://127.0.0.1:4322/test/terminal-browser.html');const result=await page.evaluate(async()=>{const fixture=await import('/test/terminal-browser-fixture.tsx');try{return await fixture.runRebindBrowserProof()}catch(error){return {passed:false,error:error.stack,facts:fixture.probeFacts()}}});await(await import('node:fs/promises')).writeFile(${JSON.stringify(output)},JSON.stringify(result));console.log(JSON.stringify(result));`
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn('ego-browser', ['nodejs', '-e', script], { cwd: mobile, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Own browser invocation deadline')) }, 20_000)
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', status => { clearTimeout(timer); resolveResult({ status, stdout, stderr }) })
    })
    await writeFile(join(evidence, `${id}.log`), `${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(await readFile(output, 'utf8'))
    if (mutation) { assert.ok(applied > 0); assert.equal(observed.passed, false); assert.match(observed.error, /AssertionError/u) }
    else { assert.equal(observed.passed, true, observed.error); assert.equal(observed.cases.length, 3) }
    return { id, applied, observed }
  } finally { await server.close() }
}
let baseline, restored, proofs
try {
  baseline = await browser(); proofs = []
  for (const mutation of mutations) proofs.push(await browser(mutation))
  restored = await browser()
} finally { await rm(join(evidence, 'vite-cache'), { recursive: true, force: true }) }
const restoredUnit = unit(); await writeFile(join(evidence, 'restored-green.log'), `${restoredUnit.stdout}${restoredUnit.stderr}`)
assert.equal(restoredUnit.status, 0); assert.match(restoredUnit.stdout, /3 passed/u)
const strictConfig = join(evidence, 'tsconfig.json')
await writeFile(strictConfig, JSON.stringify({ extends: '../../../../../apps/mobile/tsconfig.json', compilerOptions: {
  types: ['node', 'vitest/globals'], noEmit: true }, include: ['../../../../../apps/mobile/src/terminal/**/*.ts',
  '../../../../../apps/mobile/src/terminal/**/*.tsx', '../../../../../apps/mobile/test/terminal-control.test.ts',
  '../../../../../apps/mobile/test/terminal-browser-fixture.tsx'] }, null, 2) + '\n')
const typed = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', strictConfig], { cwd: repo, encoding: 'utf8' })
await writeFile(join(evidence, 'typecheck.log'), `${typed.stdout}${typed.stderr}`); assert.equal(typed.status, 0, `${typed.stdout}${typed.stderr}`)
assert.ok(viewer.includes('binding.rebind(client)') && viewer.includes('controls.current.set(agentSessionId, binding)'))
assert.ok(viewer.includes('if (selectedSession.current === agentSessionId) binding.send(data, source)'))
assert.ok((await readFile(join(mobile, 'src/MobileApp.tsx'), 'utf8')).includes('<MobileTerminalViewer client={client}'))
assert.deepEqual(await hashes(), source)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), source,
  verificationCommand: `node apps/mobile/scripts/verify-mobile-terminal-rebind.mjs --browser-space ${spaceId}`,
  unitCases: 3, actualMountedCases: baseline.observed.cases, sourceMutations: proofs.map(({ id, applied }) => ({ id, applied, assertionRed: true })),
  restoredGreen: { unitCases: 3, actualMountedCases: restored.observed.cases.length }, typecheckExitCode: typed.status,
  caller: 'Actual mounted MobileTerminalViewer → selected Session intent owner → original semantic Host/Session/Run SDK facts and input port',
  actualPhoneAccepted: false, limitations: baseline.observed.limitations }, null, 2) + '\n')
console.log('Same-page terminal rebind: 3 narrow SDK behaviors, 3 actual mounted lifecycle cases, 4 Source block AssertionRED, restored GREEN.')
