import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile, access, rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/toolkit-first-open/recovery')
assert.equal(process.argv[2], '--recovery', 'Choose the Toolkit recovery boundary')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const checkInputs = async inputs => {
  assert.ok(Object.keys(inputs).length > 0)
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Recovery proof changed: ' + file)
}
if (process.argv.includes('--run')) {
  await mkdir(evidence, { recursive: true })
  const sources = [
    'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/use-toolkit-script-observation.ts',
    'apps/desktop/src/renderer/src/components/TerminalView.tsx',
    'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts',
    'apps/desktop/src/renderer/src/lib/terminal-attachment-observation.ts',
    'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/session-observation-result.ts',
    'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/desktop-host.ts',
    'packages/connectors/src/connection-services.ts', 'apps/desktop/test/fixtures/input-authority-pty.mjs',
    'apps/desktop/test/terminal-initial-observation-recovery.test.tsx', 'apps/desktop/test/toolkit-tui-ui.test.tsx',
    'apps/desktop/test/toolkit-first-open.config.mts', 'apps/desktop/test/toolkit-tui-ui.config.mts',
    'apps/desktop/test/fixtures/terminal-observation-bridge.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/isolate-core-environment.ts', 'apps/desktop/test/helpers/local-runtime-connector.ts',
    'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
    'packages/core/test/helpers/headless-runtime-fixture.ts', 'packages/core/test/fixtures/headless-runtime-worker.mjs',
    'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/hosted-value.ts',
    'packages/core/src/runtime-observation-codec.ts', 'packages/core/src/client.ts',
    'packages/client-ui/src/terminal/replay.ts', 'test/fixture-values.mjs', 'vitest.setup.ts',
    'apps/desktop/scripts/verify-toolkit-first-open.mjs'
  ]
  // The private semantic child consumes compiled Core; record that actual condition separately.
  for (const directory of ['packages/core/dist', 'packages/core/node_modules/@ctxmux/sdk/dist', 'packages/connectors/src']) {
    for (const file of await readdir(resolve(root, directory), { recursive: true }))
      if (/\.(?:m?js|json|wasm|ts)$/.test(file) && !file.endsWith('.d.ts')) sources.push(directory + '/' + file)
  }
  sources.push(`packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`)
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const mutation of [null, 'observation-refresh', 'check-lifetime', 'check-target']) {
    const name = mutation ?? 'baseline', report = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '.jsonl')
    const resources = resolve(evidence, name + '-resources.jsonl')
    // A short platform temp root also keeps the private Native Unix socket addressable.
    const cache = await mkdtemp(resolve(tmpdir(), 'amui-'))
    await writeFile(loaded, ''); await writeFile(resources, JSON.stringify({ event: 'runner-cache', root: cache }) + '\n')
    let log = ''
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/test/toolkit-first-open.config.mts', '--reporter=json', '--outputFile=' + report],
    { cwd: root, env: { ...process.env, AGENTMUX_TUI_UI_MUTATION: mutation ?? '', AGENTMUX_TUI_UI_RECEIPT: loaded,
      TERMINAL_RECOVERY_RESOURCES: resources, TMPDIR: cache }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    await writeFile(resolve(evidence, name + '.log'), log)
    const suite = await read(report), consumed = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(suite.numPassedTests + suite.numFailedTests > 0, 'Nonempty recovery consumers required')
    assert.ok(consumed.some(item => item.file.endsWith('/TuiToolkitResult.tsx')), 'The product presenter must load')
    if (mutation) {
      assert.notEqual(code, 0, 'Recovery mutant survived')
      assert.ok(consumed.some(item => item.mutation === mutation && item.sourceSHA256 !== item.loadedSHA256))
      assert.ok(suite.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' &&
        test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), 'A consumer assertion must kill the mutant')
    } else { assert.equal(code, 0, log); assert.equal(suite.success, true) }
    const activity = (await readFile(resources, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(!activity.some(item => item.event === 'cleanup-error'), 'Private Main cleanup failed')
    for (const item of activity.filter(item => item.event === 'allocated' || item.event === 'bridge')) {
      await assert.rejects(access(item.root), 'Private fixture must be removed')
      if (item.event === 'allocated') for (const pid of [item.nativePid, item.ownerPid]) assert.throws(() => process.kill(pid, 0), 'Private process must exit')
    }
    await rm(cache, { recursive: true })
    results.push({ name, passed: suite.numPassedTests, failed: suite.numFailedTests,
      report: relative(root, report), reportSHA256: hash(await readFile(report)), loadedSHA256: hash(await readFile(loaded)),
      resourcesSHA256: hash(await readFile(resources)), privateRootsRemoved: true })
    process.stdout.write(name + ': ' + (mutation ? 'consumer rejected mutant' : 'passed') + '\n')
  }
  await checkInputs(inputs)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', inputs, results,
    scope: 'TUI to original TerminalView/Main/isolated PTY recovery; not the unidentified field protocol failure or a full App restart.' }, null, 2) + '\n')
} else {
  const receipt = await read(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.status, 'passed'); await checkInputs(receipt.inputs)
  assert.deepEqual(receipt.results.map(item => item.name), ['baseline', 'observation-refresh', 'check-lifetime', 'check-target'])
  for (const item of receipt.results) {
    assert.ok(item.name === 'baseline' ? item.passed > 0 && item.failed === 0 : item.failed > 0)
    assert.equal(hash(await readFile(resolve(root, item.report))), item.reportSHA256)
    assert.equal(hash(await readFile(resolve(evidence, item.name + '.jsonl'))), item.loadedSHA256)
    assert.equal(hash(await readFile(resolve(evidence, item.name + '-resources.jsonl'))), item.resourcesSHA256)
    assert.equal(item.privateRootsRemoved, true)
  }
  process.stdout.write('Toolkit recovery: exact consumer and mutation evidence verified\n')
}
