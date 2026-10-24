import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

assert.equal(process.platform + '-' + process.arch, 'darwin-arm64', 'This proof consumes the actual bundled private Native')
assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'), 'Unknown semantic bootstrap verification option')
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'package.json'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const owner = 'apps/desktop/scripts/package-semantic-host.mjs'
const inputs = [owner, 'apps/desktop/scripts/package-macos.mjs', 'apps/desktop/scripts/package-process-scope.mjs',
  'apps/desktop/scripts/verify-semantic-host-bootstrap.mjs', 'apps/desktop/test/package-semantic-host-bootstrap.test.ts',
  'apps/desktop/test/package-semantic-host-bootstrap.config.mts', 'apps/desktop/test/package-semantic-host-reload.test.ts',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/src/public-rpc-client.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/dist/public-rpc-client.js', 'packages/core/dist/runtime-paths.js',
  'packages/core/dist/object-id.js', 'packages/core/dist/headless-runtime-cli.js', 'packages/core/dist/headless-runtime.js',
  'packages/diagnostic-evidence/dist/index.js',
  'apps/host/dist/macos-service.js', 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd']
const sourceSHA256 = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
const original = await readFile(join(root, owner), 'utf8')
const anchor = "    maxBuffer: 64 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }"
assert.equal(original.split(anchor).length - 1, 1, 'Exact original default bootstrap exec options')
const oldTimeout = original.replace(anchor, "    timeout: 10000, maxBuffer: 64 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }")
const directory = join(root, '.local/state/semantic-host-bootstrap'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-'))
const receipt = { schema: 'agentmux.semantic-host-bootstrap.v1', passed: false, sourceStable: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceSHA256,
  loadedRawSHA256: {},
  userRuntimeTouched: false, appBuiltOrInstalled: false,
  boundary: 'Actual prepareSemanticHostReload default operations -> real execFile child -> original helper -> actual private Headless/Core fenced RPC/Native and one original Run. Only App OS observation ports are fixture facts; private Core entry delays module load with a real timer.',
  results: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
const variants = process.argv.includes('--mutations')
  ? [['candidate', original], ['restore-ten-second-timeout', oldTimeout], ['restored-candidate', original]] : [['candidate', original]]
let inventory
console.log('semantic-host-bootstrap-evidence=' + relative(root, attempt))
try {
  for (const [name, source] of variants) {
    const changed = join(attempt, name + '-source.mjs'), loaded = join(attempt, name + '-loaded.jsonl')
    const report = join(attempt, name + '.json'), product = join(attempt, name + '-product.json')
    await writeFile(changed, source)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config',
        'apps/desktop/test/package-semantic-host-bootstrap.config.mts', '--reporter=json', '--outputFile=' + report],
      { cwd: root, env: { ...process.env, AGENTMUX_SEMANTIC_BOOTSTRAP_SOURCE: changed,
        AGENTMUX_SEMANTIC_BOOTSTRAP_LOADED: loaded, AGENTMUX_SEMANTIC_BOOTSTRAP_PRODUCT: product }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const parsed = JSON.parse(await readFile(report, 'utf8'))
    const cases = parsed.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
    assert.equal(cases.length, 25, 'Exact nonempty default-consumer and original identity-fence inventory')
    const names = cases.map(test => test.fullName).sort()
    inventory ??= names
    assert.deepEqual(names, inventory, 'Same original actual consumer and refusal cases in every variant')
    const failures = cases.filter(test => test.status === 'failed')
    const facts = JSON.parse(await readFile(product, 'utf8'))
    assert.equal(facts.userRuntimeTouched, false)
    assert.ok(facts.runRetained?.pid > 1 && facts.runRetained?.runId && facts.runRetained?.nativeInstanceId, 'Original actual private Run survived the helper observation')
    const execution = facts.executions?.[0]
    assert.ok(execution?.pid > 1, 'A real bootstrap child was created')
    const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loads.length > 0)
    for (const row of loads) {
      const current = await readFile(join(root, row.path), 'utf8')
      assert.equal(row.rawSHA256, digest(current), 'Exact disk input behind the loaded module: ' + row.path)
      if (Object.hasOwn(receipt.loadedRawSHA256, row.path)) assert.equal(row.rawSHA256, receipt.loadedRawSHA256[row.path],
        'The same raw module is retained across all source variants: ' + row.path)
      else receipt.loadedRawSHA256[row.path] = row.rawSHA256
      // Vite may blank a sourceMappingURL comment before even a pre transform.
      // Its received representation and disk bytes are distinct proof objects.
      if (row.path === owner) {
        assert.equal(row.receivedSHA256, row.rawSHA256, 'The actual wrapper enters mutation from its exact raw source')
        assert.equal(row.effectiveSHA256, digest(source), 'The actual wrapper consumes its exact source variant')
      } else assert.equal(row.effectiveSHA256, row.receivedSHA256, 'Other received modules were not mutated: ' + row.path)
    }
    assert.ok(loads.some(row => row.path === owner), 'Actual default wrapper consumed its source variant')
    const mutant = name === 'restore-ten-second-timeout'
    const semanticRed = result.code === 1 && result.signal === null && failures.length === 1 &&
      failures[0].fullName.startsWith('default semantic bootstrap waits for the real delayed child') &&
      failures[0].failureMessages.some(message => /The default wrapper must accept the actual child reply after ten seconds/u.test(message)) &&
      execution.signal === 'SIGTERM' && execution.killed === true && execution.exitCode === null
    receipt.results.push({ name, code: result.code, signal: result.signal, cases: cases.length, semanticRed,
      child: execution, facts, loaded: loads,
      failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (mutant) assert.ok(semanticRed, 'Old timeout must really SIGTERM the delayed child and fail only its actual default consumer')
    else {
      assert.equal(result.code, 0, 'Default real child/identity consumer failed: ' + name)
      assert.equal(facts.passed, true); assert.equal(facts.targetRejected, true); assert.equal(facts.fenceRejected, true)
      assert.equal(execution.exitCode, 0)
      assert.ok(execution.finishedAt - execution.startedAt >= 11000, 'The real delayed child completes beyond the withdrawn ten-second wrapper budget')
    }
  }
  for (const [file, hash] of Object.entries(sourceSHA256)) assert.equal(digest(await readFile(join(root, file))), hash, 'Stable exact input: ' + file)
  for (const [file, hash] of Object.entries(receipt.loadedRawSHA256)) assert.equal(digest(await readFile(join(root, file))), hash, 'Stable actual module input: ' + file)
  receipt.sourceStable = true; receipt.passed = true
} finally { await save() }
console.log(JSON.stringify({ passed: true, receipt: join(attempt, 'receipt.json') }))
