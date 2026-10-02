import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const root = join(repository, '.tmp', 'linux-package-mutations', `run-${Date.now()}`)
const work = join(root, 'candidate')
const core = join(work, 'packages/core')
await mkdir(core, { recursive: true })
for (const path of ['src', 'bin', 'vendor']) {
  await cp(join(repository, 'packages/core', path), join(core, path), { recursive: true })
}
await mkdir(join(core, 'test'))
for (const path of ['linux-runtime-package.integration.test.ts', 'agent-terminal-checkpoint-restore.test.ts']) {
  await cp(join(repository, 'packages/core/test', path), join(core, 'test', path))
}
await cp(join(repository, 'packages/core/package.json'), join(core, 'package.json'))
await symlink(join(repository, 'node_modules'), join(work, 'node_modules'), 'dir')
await symlink(join(repository, 'packages/core/node_modules'), join(core, 'node_modules'), 'dir')
const config = join(work, 'vitest.config.mjs')
await writeFile(config, `import { defineConfig } from 'vitest/config';\nexport default defineConfig({test:{include:['packages/core/test/linux-runtime-package.integration.test.ts','packages/core/test/agent-terminal-checkpoint-restore.test.ts']}})\n`)
const vitest = join(repository, 'node_modules/vitest/vitest.mjs')
const inputs = {}
const cases = [
  { name: 'qualified-linux-owner-rejected', path: 'src/ctxmux-run-adapter.ts',
    before: "runtime.platform === 'macos' ? 'darwin' : runtime.platform",
    after: "runtime.platform === 'macos' || runtime.platform === 'linux' ? 'darwin' : runtime.platform",
    assertion: 'admits precisely the qualified host pairs and rejects unsupported combinations' },
  { name: 'daemon-dispatches-client-binary', path: 'bin/ctxmux-bin',
    before: '$amx_platform/bin/$amx_binary', after: '$amx_platform/bin/ctxmux',
    assertion: 'publishes platform dispatchers and executes the actual host binaries' },
  { name: 'installer-leaves-native-nonexecutable', path: 'bin/install-ctxmux.mjs',
    before: 'await chmod(path, 0o755)', after: 'await chmod(path, 0o644)',
    assertion: 'restores npm-normalized native modes from verified package contents' },
  { name: 'checkpoint-imports-prefix-at-final-geometry', path: 'src/agent-terminal-screen.ts',
    before: 'this.terminal.resize(checkpoint.restoreSize.cols, checkpoint.restoreSize.rows)',
    after: 'this.terminal.resize(checkpoint.size.cols, checkpoint.size.rows)',
    assertion: 'imports the complete owner seed at its acknowledged geometry before advancing the original byte fence' },
  { name: 'checkpoint-retains-temporary-history-policy', path: 'src/agent-terminal-screen.ts',
    before: 'this.terminal.options.scrollback = scrollback',
    after: 'this.terminal.options.scrollback = checkpoint.restoreScrollbackRows ?? scrollback',
    assertion: 'imports the complete owner seed at its acknowledged geometry before advancing the original byte fence' },
  { name: 'checkpoint-replays-prefix-as-suffix', path: 'src/agent-terminal-screen.ts',
    before: 'restoreBytes.subarray(checkpoint.resizeAfterRestoreBytes), resolve',
    after: 'restoreBytes, resolve',
    assertion: 'imports the complete owner seed at its acknowledged geometry before advancing the original byte fence' }
]
const results = []
async function run(name) {
  const report = join(root, `${name}.json`)
  let exitCode = 0, stdout = '', stderr = ''
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath,
      [vitest, 'run', '--config', config, '--no-file-parallelism', '--reporter=json', `--outputFile=${report}`],
      { cwd: work, maxBuffer: 4 * 1024 * 1024 }))
  } catch (error) {
    exitCode = error.code
    stdout = error.stdout ?? ''; stderr = error.stderr ?? ''
  }
  await writeFile(join(root, `${name}.log`), stdout + stderr)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const assertions = result.testResults.flatMap(test => test.assertionResults)
  assert(assertions.length > 0, 'The mutation must execute actual product assertions.')
  return { name, exitCode, assertions }
}
for (const mutation of cases) {
  const path = join(core, mutation.path)
  const original = await readFile(path, 'utf8')
  assert.equal(original.split(mutation.before).length, 2, 'Bind each mutation to one actual production block.')
  inputs[mutation.path] = createHash('sha256').update(original).digest('hex')
  await writeFile(path, original.replace(mutation.before, mutation.after))
  try {
    const result = await run(mutation.name)
    const failed = result.assertions.filter(test => test.status === 'failed')
    assert.equal(result.exitCode, 1)
    assert(failed.some(test => test.fullName.endsWith(mutation.assertion) &&
      test.failureMessages.some(message => message.includes('AssertionError'))), 'A named behavioral assertion must reject the mutation.')
    results.push({ name: mutation.name, exitCode: result.exitCode, assertionRed: true,
      failed: failed.map(test => test.fullName), executed: result.assertions.length })
  } finally { await writeFile(path, original) }
}
const green = await run('restored-green')
assert.equal(green.exitCode, 0)
assert(green.assertions.length > 0 && green.assertions.every(test => test.status === 'passed'))
await writeFile(join(root, 'receipt.json'), JSON.stringify({ schema: 'agentmux.linux-package-mutations.v1', passed: true,
  inputs, results, restored: { exitCode: green.exitCode, executed: green.assertions.length },
  method: 'Each block is mutated only in an isolated source copy; the original product assertions execute real host binaries and installer.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutations: results.length, receipt: join(root, 'receipt.json') }))
