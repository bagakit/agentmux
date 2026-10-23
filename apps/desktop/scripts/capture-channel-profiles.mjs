import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { candidateAlias } from './candidate-package-resolve.mjs'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/channel-profiles')
const mailboxReading = process.argv.slice(2).includes('--mailbox-reading')
assert.ok(process.argv.slice(2).every(argument => argument === '--mailbox-reading'), 'Unknown channel-profile capture argument')
const evidence = resolve(root, '.local/channel-protocol/channel-profiles/runs', randomUUID()), temporary = await mkdtemp(resolve(tmpdir(), 'amux-channel-profiles-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', mailboxReading,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs: {} }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  let producer
  if (mailboxReading) {
    const pointer = JSON.parse(await readFile(resolve(root, '.local/conversation-reading-integrity/t019-proof/receipt.json'), 'utf8'))
    const proofPath = pointer.run + '/receipt.json', proofBytes = await readFile(resolve(root, proofPath)), proof = JSON.parse(proofBytes.toString())
    assert.equal(proof.task, 'T-019'); assert.equal(proof.passed, true); assert.equal(proof.qualified, true)
    assert.deepEqual(proof.inputDrift, [])
    const positive = proof.results.find(result => result.name === 'positive')
    assert.equal(positive.status, 0); assert.equal(positive.mutation, null)
    const reportBytes = await readFile(resolve(root, positive.report)), report = JSON.parse(reportBytes.toString())
    assert.equal(sha(reportBytes), positive.reportSHA256); assert.equal(report.success, true)
    assert.equal(report.numPassedTests, 10); assert.equal(report.numFailedTests, 0); assert.equal(report.numFailedTestSuites, 0)
    const outputs = []
    for (const name of ['public-scene.json', 'public-mailbox-scene.json']) {
      const original = positive.outputs.find(output => output.producerPath === '.local/channel-protocol/T-005/' + name)
      assert.ok(original, 'The qualified original consumer did not produce ' + name)
      const bytes = await readFile(resolve(root, original.path))
      assert.equal(sha(bytes), original.sha256); assert.equal(original.producerReport, positive.report)
      assert.equal(original.producerReportSHA256, positive.reportSHA256)
      outputs.push({ ...original, name })
    }
    // Bind the owners whose original objects and actual row/detail layout are reused here.
    const sources = []
    for (const path of ['apps/desktop/test/channel-profile-consumer.test.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
      'apps/desktop/src/renderer/src/lib/use-channel-actor-profiles.ts', 'packages/client-ui/src/components/InputMailboxRecords.tsx',
      'packages/client-ui/src/components/ChannelProfileAvatar.tsx']) {
      const original = proof.inputs.find(input => input.path === path)
      assert.ok(original); assert.equal(sha(await readFile(resolve(root, path))), original.sha256, 'The original Mailbox consumer changed: ' + path)
      sources.push(original)
    }
    producer = { path: proofPath, sha256: sha(proofBytes), report: { path: positive.report, sha256: positive.reportSHA256 }, outputs, sources }
    receipt.producer = producer
  }
  for (const path of ['apps/desktop/scripts/capture-channel-profiles.mjs', 'apps/desktop/scripts/candidate-package-resolve.mjs',
    ...['entry.tsx', 'main.cjs', 'index.html', 'scenario.md'].map(name => 'apps/desktop/scripts/fixtures/channel-profiles/' + name)]) receipt.inputs[path] = sha(await readFile(resolve(root, path)))
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href), compiled = resolve(temporary, 'compiled')
  const alias = [candidateAlias(root, { source: true, browser: true,
    onManifest: (path, bytes) => { receipt.inputs[relative(root, path)] = sha(bytes) } }),
  ...aliases.filter(({ find }) => find.source.startsWith('^react'))]
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-channel-profiles-renderer', enforce: 'pre', resolveId: browserInstalledDependency, transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) receipt.inputs[relative(root, file)] = sha(code) } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  await cp(compiled, resolve(evidence, 'compiled'), { recursive: true })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name)).map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  if (producer) for (const output of producer.outputs) await cp(resolve(root, output.path), resolve(compiled, output.name))
  else await cp(resolve(root, '.local/channel-protocol/T-005/public-scene.json'), resolve(compiled, 'public-scene.json'))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = [], execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'index.html'), temporary, visual,
    ...(mailboxReading ? ['--mailbox-reading'] : [])], { cwd: root, temporaryRoot: temporary, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  receipt.process = execution
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.equal(render.frames.length, mailboxReading ? 8 : 5)
  if (producer) {
    for (const original of [...producer.sources, { path: producer.path, sha256: producer.sha256 }, producer.report, ...producer.outputs]) {
      assert.equal(sha(await readFile(resolve(root, original.path))), original.sha256, 'An original visual/consumer input changed: ' + original.path)
    }
    for (const output of producer.outputs) assert.equal(sha(await readFile(resolve(compiled, output.name))), output.sha256)
    assert.equal(render.mailbox.passed, true)
  }
  receipt.render = render; receipt.images = Object.fromEntries(await Promise.all(render.frames.map(async file => [file, sha(await readFile(resolve(visual, file)))])))
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.cleanup = { temporaryRoot: temporary, privateRootRemoved: false, remaining: await listProbeProcesses(-1, temporary) }; assert.deepEqual(receipt.cleanup.remaining, [])
  await rm(temporary, { recursive: true, force: true })
  receipt.cleanup.privateRootRemoved = true
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await writeFile(resolve(root, '.local/channel-protocol/channel-profiles/latest.json'), JSON.stringify({ evidence, receipt: resolve(evidence, 'receipt.json') }, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence }))
}
