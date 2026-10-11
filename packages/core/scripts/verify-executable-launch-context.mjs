import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = relative(root, fileURLToPath(import.meta.url))
const config = 'packages/core/test/executable-launch-context.config.mts'
const client = 'packages/core/src/client.ts', probe = 'packages/core/src/executable-probe.ts'
const variants = {
  'launch-path': { path: probe, needle: "context.env?.PATH ?? process.env.PATH ?? ''", replacement: "process.env.PATH ?? ''", test: 'configured-path reaches real Native' },
  'launch-workspace': { path: probe, needle: 'resolve(context.workspacePath!, value)', replacement: 'resolve(process.cwd(), value)', test: 'workspace-relative reaches real Native' },
  'create-plan': { path: client, needle: 'const executableContext = { workspacePath: input.workspacePath, env: terminalEnvironment(plan.env) }\n      const capability = await this.probeAgent(input.providerId, plan.command, executableContext)',
    replacement: 'const executableContext = { workspacePath: input.workspacePath, env: terminalEnvironment(input.env ?? {}) }\n      const capability = await this.probeAgent(input.providerId, input.commandOverride, executableContext)', test: 'checks the Provider plan command and environment' },
  'resume-plan': { path: client, needle: 'const executableContext = { workspacePath: current.workspacePath, env: terminalEnvironment(plan.env) }', replacement: 'const executableContext = {}', test: 'configured-path reaches real Native' },
  'continuity-plan': { path: client, needle: 'capability = await this.probeAgent(current.providerId, plan.command, { workspacePath: current.workspacePath, env: terminalEnvironment(plan.env) })',
    replacement: 'capability = await this.probeAgent(current.providerId, input.commandOverride)', test: 'checks the Provider plan command and environment' },
  'doctor-context': { path: 'packages/core/src/doctor.ts', needle: 'client.probeExecutorAvailability(catalog.id, commandOverride, context)',
    replacement: 'client.probeExecutorAvailability(catalog.id, commandOverride)', test: 'uses the requested private PATH and workspace' },
  'main-context': { path: 'apps/desktop/src/main/runtime-controller.ts', needle: 'probeExecutorAvailability(input.providerId, input.command, { env: environment })',
    replacement: 'probeExecutorAvailability(input.providerId, input.command)', test: 'public CLI checks the saved private PATH' },
  'cache-context': { path: 'apps/desktop/src/renderer/src/lib/executor-detection.ts',
    needle: '(input.environmentRevision ?? executorEnvironmentRevision()) !== executorEnvironmentRevision(executor.env)', replacement: 'false', test: 'public CLI checks the saved private PATH' },
  'unknown-is-not-missing': { path: probe, needle: "if (relative || unknown) return { executable, availability: 'check-failed', cause: (relative ?? unknown)! }",
    replacement: "if (relative || unknown) return { executable, availability: 'missing', cause: (relative ?? unknown)! }", test: 'keeps missing, uncertain workspace, directories and unavailable observations distinct' }
}
const hash = value => createHash('sha256').update(value).digest('hex')
if (process.argv[2] === '--worker') {
  const name = process.argv[3], output = process.argv[4], spec = variants[name]
  assert(spec && output)
  const { startVitest, parseCLI } = await import('vitest/node')
  const { filter, options } = parseCLI(['vitest', 'run', '--config', config, '--root', '.', '--maxWorkers', '1', '-t', spec.test,
    '--reporter', 'default', '--reporter', 'json', '--outputFile', join(output, name + '.json')])
  const context = await startVitest('test', filter, options, { plugins: [{
    name: 'executable-context-loaded-mutation', enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0] !== join(root, spec.path)) return
      assert.equal(source.split(spec.needle).length, 2, 'Mutation must match one actual owner')
      const code = source.replace(spec.needle, spec.replacement)
      appendFileSync(join(output, name + '.loaded.jsonl'), JSON.stringify({ path: spec.path, sourceSha: hash(source), loadedSha: hash(code), replacements: 1 }) + '\n')
      return { code, map: null }
    }
  }] })
  assert(context && context.state.getFiles().length > 0)
  await context.close()
} else {
  const output = join(root, '.tmp/session-capability-recovery/executable-context')
  await mkdir(output, { recursive: true })
  const sources = [client, probe, 'packages/core/src/doctor.ts', 'packages/core/src/control.ts', 'packages/core/src/control-codec.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/shared/executor-probe-context.ts', 'apps/desktop/src/renderer/src/lib/executor-detection.ts',
    'apps/desktop/src/renderer/src/lib/executors.ts', 'apps/desktop/src/renderer/src/store.ts',
    'packages/core/test/executable-launch-context.test.ts', 'packages/core/test/client-executor-availability.test.ts',
    'packages/core/test/doctor-unverifiable-vs-missing.test.ts', 'apps/desktop/test/executable-context-control.test.ts', config, script]
  const bind = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
  const before = await bind(), runs = [], mutations = []
  async function run(name, args) {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', chunk => { text += chunk }); child.stderr.on('data', chunk => { text += chunk })
    const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
    await writeFile(join(output, name + '.log'), text)
    runs.push({ name, code, log: relative(root, join(output, name + '.log')) })
    process.stdout.write(name + ': ' + code + '\n')
    return { code, text }
  }
  try {
    assert.equal((await run('build', ['packages/core/scripts/build.mjs'])).code, 0)
    const baseline = await run('current', ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--root', '.', '--maxWorkers', '1',
      '--reporter', 'default', '--reporter', 'json', '--outputFile', join(output, 'current.json')])
    assert.equal(baseline.code, 0, baseline.text)
    const green = JSON.parse(await readFile(join(output, 'current.json'), 'utf8'))
    assert(green.numPassedTests >= 19 && green.numFailedTests === 0, 'Nonempty exact current consumers are required')
    for (const [name, spec] of Object.entries(variants)) {
      await writeFile(join(output, name + '.loaded.jsonl'), '')
      const red = await run(name, [script, '--worker', name, output])
      const loaded = (await readFile(join(output, name + '.loaded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
      assert.equal(loaded.length, 1); assert.equal(loaded[0].sourceSha, before[spec.path]); assert.notEqual(loaded[0].sourceSha, loaded[0].loadedSha)
      assert.notEqual(red.code, 0)
      const report = JSON.parse(await readFile(join(output, name + '.json'), 'utf8'))
      const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
      assert(failed.length > 0 && failed.some(test => test.fullName.includes(spec.test)), 'The targeted consumer must fail')
      const failures = failed.flatMap(test => test.failureMessages).join('\n')
      if (name === 'resume-plan') {
        // Vitest JSON serializes a resolves assertion as Error and truncates its cause;
        // the default reporter retains the full original operation failure below it.
        assert.match(failures, /promise rejected.*configured.*instead of resolving/i)
        assert.match(red.text, /Caused by: AgentMuxError:.*Configured executable "context-runner" was not found/)
        assert.match(red.text, /code: 'AGENT_NOT_FOUND'/)
      } else assert.match(failures, /AssertionError|Configured executable.*pre-plan-command|Could not verify/)
      assert.doesNotMatch(red.text, /Session persistence unavailable|Failed to resolve entry|Failed to load|No space left|Private Native readiness unavailable|Test timed out/)
      mutations.push({ name, loaded: loaded[0], failures: failed.map(test => ({ fullName: test.fullName, failureMessages: test.failureMessages })) })
      assert.deepEqual(await bind(), before)
    }
    const after = await bind(); assert.deepEqual(after, before)
    await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.executable-launch-context-proof.v1',
      passed: true, sourceBefore: before, sourceAfter: after, baseline: green.numPassedTests, mutations, runs,
      scope: 'Private Native processes, exact Core/Hosted invocation and actual compiled CLI/Main executable detection; no user Run or application operated.' }, null, 2) + '\n')
    process.stdout.write(relative(root, join(output, 'receipt.json')) + '\n')
  } catch (error) {
    await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.executable-launch-context-proof.v1', passed: false,
      sourceBefore: before, sourceAfter: await bind(), mutations, runs, error: String(error.stack) }, null, 2) + '\n')
    throw error
  }
}
