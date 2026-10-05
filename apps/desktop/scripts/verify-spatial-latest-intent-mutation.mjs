import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, process.argv[2] ?? `.tmp/ui-design-cohesion/continuity-mutation-${randomUUID()}`)
await mkdir(evidence, { recursive: true })
const source = 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'
const test = 'apps/desktop/test/desktop-spatial-latest-intent.test.ts'
const before = await readFile(join(root, source), 'utf8')
const mutations = [
  { name: 'latest-intent', anchor: 'sameSpatialValue(graph, this.pending?.graph ?? this.state!.graph)',
    replacement: 'sameSpatialValue(graph, this.state!.graph)',
    pattern: '^(keeps the later return|coalesces repeated identical)', count: 3 },
  { name: 'unknown-intent', anchor: 'const uncertain = this.unconfirmed;', replacement: 'const uncertain = null;',
    pattern: '^keeps the return to A after an unknown write \\(applied=true', count: 2 },
  { name: 'independent-name-ack', anchor: 'this.saving || this.unconfirmed ? { ...this.pending }',
    replacement: 'false ? { ...this.pending }', pattern: '^accepts an independent name ACK', count: 2 },
]
for (const mutation of mutations) {
  assert.equal(before.split(mutation.anchor).length, 2, 'One production mutation owner')
  await writeFile(join(evidence, `${mutation.name}.config.mjs`), `
import { mergeConfig } from 'vitest/config'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
export default mergeConfig(base, { plugins: [{
  name: ${JSON.stringify(mutation.name)}, enforce: 'pre',
  transform(code, id) {
    if (id.split('?')[0] !== ${JSON.stringify(join(root, source))}) return
    if (!code.includes(${JSON.stringify(mutation.anchor)})) throw Error('Production mutation anchor missing')
    return code.replace(${JSON.stringify(mutation.anchor)}, ${JSON.stringify(mutation.replacement)})
  }
}] })
`)
}
const phases = []
for (const name of ['baseline', ...mutations.map(mutation => mutation.name), 'restored']) {
  const mutation = mutations.find(mutation => mutation.name === name)
  const report = join(evidence, `${name}.json`)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', test,
    '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  if (mutation) args.push('--config', join(evidence, `${name}.config.mjs`), '--testNamePattern', mutation.pattern)
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  await writeFile(join(evidence, `${name}.log`), result.stdout + result.stderr)
  assert.equal(result.error, undefined, `${name}: no setup or timeout failure`)
  const facts = JSON.parse(await readFile(report, 'utf8'))
  const assertions = facts.testResults.flatMap(file => file.assertionResults)
    .filter(item => item.status === 'passed' || item.status === 'failed')
  assert.equal(assertions.length, mutation?.count ?? 14, 'All selected original owner scenarios actually ran')
  if (mutation) {
    assert.equal(result.status, 1)
    assert.equal(facts.numFailedTests, mutation.count)
    assert.equal(facts.numPassedTests, 0)
    for (const item of assertions) {
      assert.equal(item.status, 'failed')
      const expected = name === 'independent-name-ack'
        ? 'A name ACK must not replace the later Region intent with its older layout snapshot'
        : name === 'unknown-intent'
        ? 'Retry preserves the later A even if B was written without an ACK'
        : item.title.startsWith('keeps the later return')
        ? 'Later return to A is an intent while B is in flight'
        : 'The same in-flight intent does not create another public commit'
      assert.ok(item.failureMessages.some(message => message.includes('AssertionError') && message.includes(expected)),
        'The actual focus/write assertion kills the production mutation')
    }
  } else {
    assert.equal(result.status, 0)
    assert.equal(facts.numPassedTests, 14)
    assert.equal(facts.numFailedTests, 0)
    assert.equal(facts.numPendingTests, 0)
  }
  phases.push({ name, exitCode: result.status, assertions })
}
assert.equal(await readFile(join(root, source), 'utf8'), before, 'Private mutation never writes shared production source')
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = {
  schema: 'agentmux.spatial-latest-intent-mutation.v1', passed: true, source,
  sourceSha256: hash(before), test, testSha256: hash(await readFile(join(root, test))), phases,
  boundary: 'Original DesktopSpatialPersistence and private file-backed Core store; no Session/Run or installed-package claim.',
}
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json') }))
