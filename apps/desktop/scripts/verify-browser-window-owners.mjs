import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const output = join(repository, '.local/browser-default/window-owner-proof')
const products = ['ipc.ts', 'browser-view-manager.ts', 'native-overlay-windows.ts'].map(file => 'apps/desktop/src/main/' + file)
const tests = ['browser-window-owner-lifecycle.test.ts', 'browser-presentation-resource.test.ts', 'native-overlay-windows.test.ts'].map(file => 'apps/desktop/test/' + file)
const sourceFiles = [...products, ...tests, 'apps/desktop/scripts/verify-browser-window-owners.mjs', 'vitest.config.ts', 'vitest.dist-freshness.ts',
  'packages/core/dist/index.js', 'packages/core/dist/client.js', 'packages/client-ui/dist/note/note-merge-identity.js']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(repository, file)))])))
await mkdir(output, { recursive: true })
const before = await manifest(), temporary = await mkdtemp(join(output, 'isolated-'))
const receipt = { schema: 'agentmux.browser-window-owner-proof.v1', runId: randomUUID(), status: 'running',
  candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), sourceInputs: before, runs: [] }
const save = async () => {
  const path = join(output, 'receipt-' + receipt.runId + '.tmp')
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n'); await rename(path, join(output, 'receipt.json'))
}
async function run(name, variant) {
  const loadedPath = join(output, name + '-loaded.jsonl'), reportPath = join(output, name + '.json'), logPath = join(output, name + '.log')
  await writeFile(loadedPath, '')
  let changed
  if (variant) {
    const original = await readFile(join(repository, variant.path), 'utf8')
    assert.equal(original.split(variant.from).length, 2, name + ': exact mutation anchor must be unique')
    const file = join(temporary, name + '.ts'), bytes = original.replace(variant.from, variant.to)
    await writeFile(file, bytes)
    changed = { path: variant.path, privateFile: file, originalSha256: hash(original), loadedSha256: hash(bytes), expectedTest: variant.test }
  }
  const configPath = join(temporary, name + '.config.mjs')
  await writeFile(configPath, `import base from ${JSON.stringify(join(repository, 'vitest.config.ts'))};
import { mergeConfig } from 'vitest/config';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sources=${JSON.stringify(products.map(file => join(repository, file)))};
export default mergeConfig(base,{plugins:[{name:'exact-window-owner-bytes',enforce:'pre',load(id){
const original=id.split('?')[0];if(!sources.includes(original))return;
const from=${JSON.stringify(changed ? join(repository, changed.path) : null)};
const file=original===from?${JSON.stringify(changed?.privateFile ?? null)}:original;
const code=readFileSync(file,'utf8');appendFileSync(${JSON.stringify(loadedPath)},JSON.stringify({original,file,sha256:createHash('sha256').update(code).digest('hex')})+'\\n');return code;
}}],test:{reporters:['json'],outputFile:${JSON.stringify(reportPath)}}});
`)
  let stdout = '', stderr = '', interruption = null
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath, ...tests, '--maxWorkers=1', '-t', 'closed workbench owners'],
      { cwd: repository, env: { ...process.env, pnpm_config_verify_deps_before_run: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let kill
    const timer = setTimeout(() => { interruption = 'timeout'; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 1_500) }, 90_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { clearTimeout(timer); clearTimeout(kill); no(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(kill); yes({ code, signal, interruption }) })
  })
  await writeFile(logPath, stdout + stderr)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.testResults.map(item => item.name).sort(), tests.map(file => join(repository, file)).sort(), name + ': only the three original consumer files count')
  const cases = report.testResults.flatMap(item => item.assertionResults).filter(test => test.fullName.startsWith('closed workbench owners'))
  assert.equal(cases.length, 4, name + ': collect exactly four nonempty lifecycle consumers')
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const file of products) {
    const rows = loaded.filter(item => item.original === join(repository, file))
    assert.ok(rows.length > 0, name + ': original owner was not consumed: ' + file)
    const expected = changed?.path === file ? changed.loadedSha256 : before[file]
    assert.ok(rows.every(item => item.sha256 === expected), name + ': exact loaded bytes differ: ' + file)
  }
  assert.equal(result.interruption, null, name + ': interruption is not a product RED')
  if (!variant) {
    assert.equal(result.code, 0, name + ': source lifecycle must pass')
    assert.equal(report.numFailedTests, 0)
    assert.ok(cases.every(test => test.status === 'passed'), name + ': all exact lifecycle consumers must pass')
  } else {
    assert.notEqual(result.code, 0, name + ': removed fix must fail')
    assert.equal(result.signal, null)
    assert.ok(cases.some(test => test.fullName === variant.test && test.status === 'failed'), name + ': actual target assertion must be RED, never a missing suite or environment error')
  }
  assert.deepEqual(await manifest(), before, name + ': immutable owner inputs changed')
  receipt.runs.push({ name, ...result, total: cases.length, passed: cases.filter(test => test.status === 'passed').length,
    failed: cases.filter(test => test.status === 'failed').length, loaded, variant: changed ?? null })
  await save(); process.stdout.write(name + ': ' + (variant ? 'expected exact consumer RED' : 'GREEN') + '\n')
}
try {
  await save(); await run('source')
  if (process.argv.includes('--mutations')) {
    await run('destroyed-ipc-getter', { path: products[0], from: "contents.off('destroyed', closeMetrics)", to: "args.window.webContents.off('destroyed', closeMetrics)",
      test: 'closed workbench owners release the exact registered IPC document after native getters are gone' })
    await run('destroyed-session-getter', { path: products[1], from: 'requesterSession.setDisplayMediaRequestHandler(null)', to: 'sender.session.setDisplayMediaRequestHandler(null)',
      test: 'closed workbench owners revoke late media requests and release the exact original Session' })
    await run('destroyed-window-observation', { path: products[1], from: '    if (this.presentationDisposed || this.window.isDestroyed()) return false\n    const sender = this.window.webContents',
      to: '    const sender = this.window.webContents\n    if (this.presentationDisposed || this.window.isDestroyed()) return false',
      test: 'closed workbench owners revoke late media requests and release the exact original Session' })
    await run('destroyed-projection-getter', { path: products[2], from: "contents.off('did-start-navigation', navigation)", to: "window.webContents.off('did-start-navigation', navigation)",
      test: 'closed workbench owners release native projections without reading a destroyed Window getter' })
    await run('restored-source')
  }
  receipt.status = 'passed'; await save()
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { name: error.name, message: error.message }; await save(); throw error
} finally { await rm(temporary, { recursive: true, force: true }) }
