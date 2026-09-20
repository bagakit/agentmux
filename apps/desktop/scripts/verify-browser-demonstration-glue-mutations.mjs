import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/browser-demonstration-glue-mutations'))
const isolated = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-demo-glue-')))
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const managerTest = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const paneTest = 'apps/desktop/test/browser-demonstration-wiring.test.tsx'
const trustTest = 'apps/desktop/test/ipc-sender-trust.test.ts'
const release = '// Capture releases its native/CDP owner before its first await. Durable draft writes do not gate a healthy run.\n    void this.releaseDemonstrationCapture(entry)'
const cases = [
  ['old-capture-overwrites-new', manager, 'if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) return', 'if (!this.owns(entry, view) || contents.isDestroyed()) return', managerTest],
  ['late-start-returns-recording', manager, 'if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) {', 'if (!this.owns(entry, view) || contents.isDestroyed()) {', managerTest],
  ['draft-storage-blocks-healthy-agent', manager, release, release.replace('void this.', 'await this.'), managerTest],
  ['agent-does-not-release-capture', manager, release, release.replace('void this.releaseDemonstrationCapture(entry)', 'void 0'), managerTest],
  ['restore-starts-recording', manager, 'void this.getDemonstration(id).catch', 'void this.startDemonstration(id).catch', managerTest],
  ['draft-snapshot-projection-disconnected', manager, '...(entry.demonstration ? { demonstration: entry.demonstration } : {}),', '...{},', managerTest],
  ['synthetic-toolbar-can-record', pane, 'if (event.nativeEvent.isTrusted !== true) return', 'if (false) return', paneTest],
  ['renderer-does-not-consume-draft', pane, 'draft={tab.demonstration?.draft ?? null}', 'draft={null}', paneTest],
  ['untrusted-ipc-can-record', 'apps/desktop/src/main/ipc.ts', "    requireTrustedSender('browser:startDemonstration', event)", '    void event', trustTest]
]
const inputs = [...new Set([manager, pane, ...cases.map(([, file]) => file), managerTest, paneTest, trustTest,
  'apps/desktop/src/main/browser-demonstration-capture.ts', 'apps/desktop/src/main/browser-demonstration-recorder.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts'])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...original].map(([file, bytes]) => [file, hash(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared', 'apps/desktop/src/renderer/src', 'apps/desktop/src/preload']) {
    await fs.cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })
  }
  await fs.symlink(path.join(root, 'apps/desktop/resources'), path.join(isolated, 'apps/desktop/resources'), 'dir')
  await fs.mkdir(path.join(isolated, 'apps/desktop/test'), { recursive: true })
  for (const file of [managerTest, paneTest, trustTest]) await fs.writeFile(path.join(isolated, file), original.get(file))
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  const config = path.join(isolated, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify([managerTest, paneTest, trustTest])} } }\n`)
  const run = async (name, test) => {
    const args = [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', test, '--root', isolated, '--config', config, '--maxWorkers=1']
    if (test === managerTest) args.push('-t', 'human demonstration via')
    const result = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  for (const test of [managerTest, paneTest, trustTest]) assert.equal((await run(`baseline-${path.basename(test)}`, test)).exit, 0, `Baseline must pass: ${test}`)
  for (const [name, file, before, after, test] of cases) {
    const source = original.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${name}`)
    await fs.writeFile(path.join(isolated, file), source.replace(before, after))
    try {
      const red = await run(name, test)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Must fail at behavioral assertions: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally { await fs.writeFile(path.join(isolated, file), original.get(file)) }
  }
  for (const test of [managerTest, paneTest, trustTest]) assert.equal((await run(`restored-${path.basename(test)}`, test)).exit, 0, `Restored source must pass: ${test}`)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fs.rm(isolated, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Inspect concurrent edits before closing the task')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, evidence }))
