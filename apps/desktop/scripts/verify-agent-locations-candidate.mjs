import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const directory = path.join(root, '.tmp/agent-locations/candidate')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(directory, { recursive: true })
const receipt = { passed: false, commands: [] }
await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
try {
  Object.assign(receipt, { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), mainAtStart: git('rev-parse', 'main') })
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Validate a clean committed candidate')
  git('merge-base', '--is-ancestor', receipt.sourceCommit, 'main')
  const commands = [
    ['mobile-default-matrix', ['--filter', '@agentmux/mobile', 'test']],
    ['mobile-typecheck', ['--filter', '@agentmux/mobile', 'typecheck']],
    ['desktop-typecheck', ['--filter', '@agentmux/desktop', 'typecheck']],
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
    assert.equal(exit.code, 0, `${name} failed: inspect its original log`)
    assert.equal(exit.signal, null)
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
