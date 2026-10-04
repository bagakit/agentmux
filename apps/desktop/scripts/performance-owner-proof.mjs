import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
export const proofRoot = resolve(import.meta.dirname, '../../..')
export const sha = value => createHash('sha256').update(value).digest('hex')
export function provePerformanceOwner(spec) {
  const root = proofRoot, directory = join(root, '.local/state/performance-owner-proof', spec.name, String(globalThis.crypto.randomUUID()))
  mkdirSync(directory, { recursive: true })
  const owners = Object.fromEntries(spec.owners.map(path => [path, readFileSync(join(root, path), 'utf8')]))
  const receipt = { passed: false, root, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    verifierSHA256: sha(readFileSync(process.argv[1])), helperSHA256: sha(readFileSync(import.meta.filename)),
    sourceSHA256: Object.fromEntries(Object.entries(owners).map(([path, code]) => [path, sha(code)])),
    testSHA256: Object.fromEntries(spec.tests.map(path => [path, sha(readFileSync(join(root, path)))])), callers: [], runs: [], userRunTouched: false }
  const env = { ...process.env, pnpm_config_verify_deps_before_run: '' }
  function run(name, mutation, tests) {
    const sources = Object.fromEntries(Object.entries(owners).map(([path, code]) => [join(root, path), mutation?.path === path ? mutation.code : code]))
    const report = join(directory, name + '.json'), loaded = join(directory, name + '.loaded.json'), config = join(directory, name + '.config.mts'), astLoaded = join(directory, name + '.ast-loaded.jsonl')
    const defines = Object.fromEntries((spec.astOwners ?? []).map(([path, define]) => [define, JSON.stringify(sources[join(root,path)])]))
    writeFileSync(config, `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}\nimport {writeFileSync} from 'node:fs'\nimport {createHash} from 'node:crypto'\nconst sources=${JSON.stringify(sources)}, loaded={}\nexport default {...base, root:${JSON.stringify(root)}, define:{...base.define,...${JSON.stringify(defines)}}, plugins:[{name:'actual-owner-source',enforce:'pre',transform(code,id){const path=id.split('?')[0];if(!(path in sources))return;const value=sources[path];loaded[path]=createHash('sha256').update(value).digest('hex');writeFileSync(${JSON.stringify(loaded)},JSON.stringify(loaded));return {code:value,map:null}}}],test:{...base.test,include:${JSON.stringify(tests)},maxWorkers:1,testTimeout:12000}}\n`)
    const child = spawnSync('pnpm', ['exec','vitest','run','--config',config,'--reporter=json','--outputFile',report], { cwd: root,
      env: { ...env, AGENTMUX_TERMINAL_INPUT_LOADED: astLoaded, AGENTMUX_TERMINAL_INPUT_SOURCE_PATH: join(root,'apps/desktop/src/renderer/src/components/TerminalView.tsx') }, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
    writeFileSync(join(directory, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
    assert.equal(child.error, undefined); assert.equal(child.signal, null)
    const result = JSON.parse(readFileSync(report)), loadedSources = JSON.parse(readFileSync(loaded))
    if (spec.astOwners && tests.includes('apps/desktop/test/terminal-input-performance.test.ts')) {
      const executions = readFileSync(astLoaded,'utf8').trim().split('\n').map(value => JSON.parse(value))
      assert.ok(executions.length > 0, 'AST execution evidence missing')
      for (const execution of executions) {
        assert.deepEqual(execution.declarations, ['sendInput','pasteInput','input','oscHandlers'])
        assert.match(execution.executedDeclarationsSHA256, /^[a-f0-9]{64}$/u)
        loadedSources[execution.path] = execution.sourceSHA256
      }
    }
    assert.ok(result.numTotalTests >= (mutation ? 1 : spec.minimumTests), 'empty/incomplete test collection')
    assert.equal(result.numPendingTests, 0)
    if (mutation) {
      assert.equal(child.status, 1)
      assert.ok(result.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))), 'must fail an executed assertion')
      assert.equal(loadedSources[join(root, mutation.path)], sha(mutation.code), 'actual mutant was not loaded')
    } else {
      assert.equal(child.status, 0); assert.equal(result.numFailedTests, 0)
      for (const [path, code] of Object.entries(owners)) assert.equal(loadedSources[join(root,path)], sha(code), `owner not loaded: ${path}`)
    }
    receipt.runs.push({ name, tests: result.numTotalTests, failed: result.numFailedTests, loadedSources })
  }
  try {
    run('normal', null, spec.tests)
    for (const [name, path, before, after, tests] of spec.mutants) {
      const source = owners[path]
      assert.equal(source.split(before).length, 2, `mutant anchor must occur once: ${name}`)
      run(name, { path, code: source.replace(before, after) }, tests ?? spec.mutantTests)
    }
    for (const [path, anchor] of spec.callers) {
      const source = readFileSync(join(root,path),'utf8'), count = source.split(anchor).length - 1
      assert.ok(count > 0, `no production caller: ${path} ${anchor}`)
      receipt.callers.push({ path, anchor, count, sha256: sha(source) })
    }
    for (const [path, source] of Object.entries(owners)) assert.equal(sha(readFileSync(join(root,path))), sha(source), 'source changed during proof')
    for (const path of spec.tests) assert.equal(sha(readFileSync(join(root,path))), receipt.testSHA256[path], 'test changed during proof')
    assert.equal(sha(readFileSync(process.argv[1])), receipt.verifierSHA256)
    assert.equal(sha(readFileSync(import.meta.filename)), receipt.helperSHA256)
    receipt.passed = true
  } finally { writeFileSync(join(directory,'receipt.json'), JSON.stringify(receipt,null,2)+'\n') }
  process.stdout.write(JSON.stringify({ passed: true, receipt: join(directory,'receipt.json') })+'\n')
  return { directory, receipt }
}
