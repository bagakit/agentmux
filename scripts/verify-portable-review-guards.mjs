import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isolatedGitEnvironment } from '../test/helpers/review-guard-isolation.mjs'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const tests = ['test/tracker-gate-names-existing-tests.test.ts', 'apps/desktop/test/commit-message-anchor-provenance.test.ts', 'apps/desktop/test/commit-fix-guard-coupling.test.ts']
const scanner = 'scripts/audit-tracker-test-targets.mjs'
const anchors = 'apps/desktop/scripts/commit-message-anchor-provenance.mjs'
const coupling = 'apps/desktop/scripts/commit-fix-guard-coupling.mjs'
const owners = [scanner, anchors, coupling, 'test/helpers/review-guard-isolation.mjs', 'test/helpers/review-git-fixture.ts']
const files = ['scripts/verify-portable-review-guards.mjs', 'test/helpers/review-guard-isolation.mjs', 'package.json', 'vitest.setup.ts', 'test/portable-review-guards.config.mts', 'test/helpers/review-git-fixture.ts', ...tests, scanner, anchors, coupling]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(files.map(async file => [file, await readFile(join(root, file))])))
const evidence = join(root, '.local/takeover-ijpp/foundation-closure/portable-review-guards')
const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-portable-guards-')))
const mutations = [
  { name: 'missing-target-ignored', file: scanner, test: tests[0], before: 'return !existsSync(absolute) && globSync(`${absolute}*`).length === 0', after: 'return false' },
  { name: 'empty-scan-audited', file: scanner, test: tests[0], before: "commands > 0 && named.length > 0 ? 'audited' : 'unconfirmed'", after: "'audited'" },
  { name: 'anchor-scan-empty', file: anchors, test: tests[1], before: '  return out\n}', after: '  return []\n}' },
  { name: 'committed-file-read-bypassed', file: anchors, test: tests[1], before: "return await gitLines(['show', `${sha}:${path}`])", after: "return 'first\\nsecond\\nthird\\n'" },
  { name: 'changed-tree-read-empty', file: coupling, test: tests[2], before: "const out = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])", after: "const out = ''" },
  { name: 'commit-message-read-empty', file: coupling, test: tests[2], before: "async function screen(sha) {\n  const message = await git(['log', '-1', '--format=%B', sha])", after: "async function screen(sha) {\n  const message = ''" }
]
const receipt = { sourceRoot: root, sandbox, sourceSHA256: Object.fromEntries([...original].map(([file, bytes]) => [file, digest(bytes)])), cases: [], cleanup: 'pending' }
const env = { ...isolatedGitEnvironment(), NO_COLOR: '1' }
async function run(label, selected, mutation) {
  const report = join(evidence, `${label}.json`), loads = join(evidence, `${label}-loaded.jsonl`)
  await writeFile(loads, '')
  let code = 0, stdout = '', stderr = ''
  try {
    const result = await exec(process.execPath, [join(sandbox, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(sandbox, 'verify.config.mts'),
      ...selected, '--reporter=default', '--reporter=json', `--outputFile=${report}`], { cwd: sandbox, env: { ...env, AGENTMUX_GUARD_LOADED: loads }, maxBuffer: 8 * 1024 * 1024 })
    stdout = result.stdout; stderr = result.stderr
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''
  }
  await writeFile(join(evidence, `${label}.log`), stdout + stderr)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(result.numTotalTests > 0, `${label}: no tests`)
  assert.deepEqual(result.testResults.map(item => item.name).sort(), selected.map(file => join(sandbox, file)).sort(), `${label}: wrong test sources`)
  const loaded = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, `${label}: no owner source load`)
  if (mutation) {
    assert.notEqual(code, 0, `${label}: mutant survived`)
    assert.ok(result.numFailedTests > 0, `${label}: no assertion failed`)
    assert.ok(result.testResults.flatMap(item => item.assertionResults).some(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))), `${label}: failure was not an assertion`)
    const sha256 = digest(await readFile(join(sandbox, mutation.file)))
    assert.ok(loaded.some(item => item.file === mutation.file && item.sha256 === sha256), `${label}: mutated owner was not loaded`)
    receipt.cases.push({ mutation: label, file: mutation.file, sha256, failedTests: result.numFailedTests, passedTests: result.numPassedTests })
  } else {
    assert.equal(code, 0, stdout + stderr)
    assert.equal(result.numFailedTests, 0)
    assert.equal(result.numPassedTests, result.numTotalTests)
    for (const file of owners) assert.ok(loaded.some(item => item.file === file && item.sha256 === receipt.sourceSHA256[file]), `${label}: wrong owner source ${file}`)
    receipt[label] = { passedTests: result.numPassedTests, testFiles: result.testResults.length }
  }
  console.log(`${label}: ${result.numFailedTests} failed | ${result.numPassedTests} passed`)
}
try {
  await mkdir(evidence, { recursive: true })
  for (const [file, bytes] of original) { await mkdir(dirname(join(sandbox, file)), { recursive: true }); await writeFile(join(sandbox, file), bytes) }
  await symlink(await realpath(join(root, 'node_modules')), join(sandbox, 'node_modules'))
  // Only external Node test tooling is shared. Every tested owner and fixture is copied from this candidate.
  await writeFile(join(sandbox, 'verify.config.mts'), `import base from './test/portable-review-guards.config.mts';\nimport { appendFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { relative } from 'node:path';\nconst owners = ${JSON.stringify(owners)};\nexport default { ...base, plugins: [{ name: 'exact-guard-source', enforce: 'pre', transform(source, id) { const file = relative(${JSON.stringify(sandbox)}, id.split('?')[0]); if (owners.includes(file)) appendFileSync(process.env.AGENTMUX_GUARD_LOADED, JSON.stringify({file, sha256:createHash('sha256').update(source).digest('hex')})+'\\n'); } }] };\n`)
  await exec('git', ['init', '--quiet'], { cwd: sandbox, env })
  assert.equal(await readFile(join(sandbox, '.git/HEAD'), 'utf8').then(Boolean), true)
  await assert.rejects(readFile(join(sandbox, '.bagakit'), 'utf8'), { code: 'ENOENT' })
  for (const sha of ['5815fa58', '3afe619']) await assert.rejects(exec('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: sandbox, env }))
  receipt.isolation = { trackerAbsent: true, historicalCommitsAbsent: true, dependencyRoot: await realpath(join(sandbox, 'node_modules')) }
  await run('baseline', tests)
  for (const mutation of mutations) {
    const source = original.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length, 2, `Unique source anchor: ${mutation.name}`)
    try {
      await writeFile(join(sandbox, mutation.file), source.replace(mutation.before, mutation.after))
      await run(mutation.name, [mutation.test], mutation)
    } finally { await writeFile(join(sandbox, mutation.file), original.get(mutation.file)) }
  }
  await run('restored', tests)
  for (const [file, bytes] of original) assert.equal(digest(await readFile(join(root, file))), digest(bytes), `Candidate changed while proving ${file}`)
  receipt.passed = true
} finally {
  await rm(sandbox, { recursive: true, force: true })
  receipt.cleanup = 'removed-private-repository'
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), mutations: receipt.cases.length }))
