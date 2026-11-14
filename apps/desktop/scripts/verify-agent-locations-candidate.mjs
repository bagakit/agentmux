import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { activityTestFiles } from './typecheck-activity-tests.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const directory = path.join(root, '.tmp/agent-locations/candidate')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function unchangedActivityBaseline(logPath) {
  const baseline = path.join(root, '.tmp/agent-locations/before/activity-baseline')
  const files = JSON.parse(await readFile(path.join(baseline, 'files.json'), 'utf8'))
  assert.equal(Object.keys(files).length, 5)
  for (const [file, digest] of Object.entries(files)) assert.equal(sha(await readFile(path.join(baseline, file))), digest)
  const control = JSON.parse(await readFile(path.join(baseline, 'receipt.json'), 'utf8'))
  const prior = JSON.parse(await readFile(path.join(baseline, 'diagnostics.json'), 'utf8'))
  const callers = JSON.parse(await readFile(path.join(baseline, 'activity-callers.json'), 'utf8'))
  assert.equal(control.sourceAliasesRequested, false); assert.equal(control.mutationsRequested, false)
  assert.equal(control.finalStatus, '')
  assert.equal(control.commands.find(command => command.name === 'desktop-dependency-build')?.exitCode, 0)
  assert.equal(control.commands.find(command => command.name === 'desktop-typecheck')?.exitCode, 1)
  assert.equal(git('rev-parse', `${control.selectedMain.commit}^{tree}`), control.selectedMain.tree)
  git('merge-base', '--is-ancestor', control.selectedMain.commit, 'HEAD')
  for (const [file, digest] of Object.entries(control.checkerInputsSHA256)) assert.equal(sha(await readFile(path.join(root, file))), digest, 'Original compiler/checker/config changed')
  const output = path.join(directory, 'desktop-type-baseline-comparison.json')
  const parsed = spawnSync('python3', [path.join(baseline, 'normalize.py'), logPath, '--repo', root, '--previous-log', path.join(baseline, 'desktop-typecheck.log'), '--previous-repo', control.worktree, '--output', output], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
  const result = JSON.parse(await readFile(output, 'utf8'))
  for (const footer of [prior.checkerFooter, result.checkerFooter]) for (const field of ['testRoots', 'sourceFiles', 'firstPartyExports', 'manifests', 'diagnostics']) assert.ok(Number.isInteger(footer?.[field]) && footer[field] > 0, `Incomplete original checker footer: ${field}`)
  assert.ok(Array.isArray(callers) && callers.length === prior.checkerFooter.testRoots && new Set(callers).size === callers.length)
  const currentCallers = new Set(activityTestFiles(root).map(file => path.relative(root, file)))
  for (const file of callers) assert.ok(currentCallers.has(file), `Original Activity caller disappeared: ${file}`)
  assert.ok(prior.totalDiagnostics > 0 && prior.checkerFooter.testRoots > 0)
  assert.ok(result.checkerFooter?.testRoots >= prior.checkerFooter.testRoots, 'Original Activity callers cannot disappear')
  assert.equal(result.comparison?.exactNormalizedMultisetEqual, true, 'Type errors changed from the committed-main control')
  assert.deepEqual(result.comparison.added, []); assert.deepEqual(result.comparison.removed, [])
  assert.equal(result.totalDiagnostics, prior.totalDiagnostics)
  return { originalExitCode: 1, disposition: 'unchanged-existing-activity-test-errors', sourceCommit: control.selectedMain.commit, diagnostics: result.totalDiagnostics, comparison: path.relative(root, output) }
}
await mkdir(directory, { recursive: true })
const receipt = { passed: false, commands: [] }
await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
try {
  Object.assign(receipt, { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), mainAtStart: git('rev-parse', 'main') })
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Validate a clean committed candidate')
  git('merge-base', '--is-ancestor', receipt.sourceCommit, 'main')
  const commands = [
    ['workspace-files-helper', ['--filter', '@agentmux/desktop', 'build:workspace-move-helper']],
    ['mobile-default-matrix', ['--filter', '@agentmux/mobile', 'test']],
    ['mobile-typecheck', ['--filter', '@agentmux/mobile', 'typecheck']],
    ['desktop-typecheck', ['--filter', '@agentmux/desktop', 'typecheck']],
    ['desktop-location-test-types', ['--filter', '@agentmux/desktop', 'exec', 'node', 'scripts/typecheck-agent-location-tests.mjs']],
    ['desktop-build', ['--filter', '@agentmux/desktop', 'build']],
    ['mobile-build', ['--filter', '@agentmux/mobile', 'build']],
  ]
  for (const [name, args] of commands) {
    const logPath = path.join(directory, `${name}.log`)
    const log = await open(logPath, 'w')
    const result = { name, executable: 'pnpm', args: ['--config.verify-deps-before-run=false', ...args], startedAt: new Date().toISOString(), logPath: path.relative(root, logPath) }
    receipt.commands.push(result)
    console.log(`agent-locations: ${name}; log ${result.logPath}`)
    let exit
    try {
      exit = await new Promise((resolve, reject) => {
        const child = spawn('pnpm', result.args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', VITEST_MAX_FORKS: '2', VITEST_MIN_FORKS: '1', VITEST_MAX_THREADS: '2', VITEST_MIN_THREADS: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192' }, stdio: ['ignore', log.fd, log.fd] })
        result.pid = child.pid
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
    } finally { await log.close() }
    Object.assign(result, exit, { finishedAt: new Date().toISOString(), logSHA256: sha(await readFile(logPath)) })
    assert.equal(exit.signal, null)
    if (name === 'desktop-typecheck' && exit.code === 1) result.existingBaseline = await unchangedActivityBaseline(logPath)
    else assert.equal(exit.code, 0, `${name} failed: inspect its original log`)
    if (name === 'mobile-default-matrix') {
      const output = (await readFile(logPath, 'utf8')).replace(/\x1b\[[0-9;]*m/g, '')
      const files = output.match(/Test Files\s+(\d+) passed/)
      const tests = output.match(/Tests\s+(\d+) passed/)
      assert.ok(files && Number(files[1]) > 0 && tests && Number(tests[1]) > 0, 'No successful default matrix summary')
      receipt.mobileDefaultMatrix = { passedFiles: Number(files[1]), passedTests: Number(tests[1]), invocation: result.args }
    }
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/mobile/dist/mobile-release.json'), 'utf8'))
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'No built Mobile release files')
  for (const file of manifest.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'))
    const bytes = await readFile(path.join(root, 'apps/mobile/dist', file.path))
    assert.equal(bytes.byteLength, file.bytes)
    assert.equal(`sha256:${sha(bytes)}`, file.digest)
  }
  receipt.mobileRelease = manifest
  // Desktop packaging builds Mobile again with a new buildId. Keep the exact
  // validated namespace available for explicit publication without rebuilding it.
  receipt.mobileReleasePath = path.relative(root, path.join(directory, `mobile-${manifest.buildId}`))
  await cp(path.join(root, 'apps/mobile/dist'), path.join(root, receipt.mobileReleasePath), { recursive: true, force: false, errorOnExist: true })
  for (const file of manifest.files) assert.equal(`sha256:${sha(await readFile(path.join(root, receipt.mobileReleasePath, file.path)))}`, file.digest)
  assert.equal(git('rev-parse', 'HEAD'), receipt.sourceCommit, 'Source changed during validation')
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Build changed tracked source; commit generated inputs before validating')
  receipt.passed = true
} catch (error) {
  receipt.error = String(error.stack || error)
  process.exitCode = 1
} finally {
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: path.relative(root, path.join(directory, 'receipt.json')), sourceCommit: receipt.sourceCommit }))
}
