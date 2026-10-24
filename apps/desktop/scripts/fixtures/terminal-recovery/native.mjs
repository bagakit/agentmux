import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { stopProbeProcesses } from '../../probe-process.mjs'
const [receipt] = process.argv.slice(2)
const root = await mkdtemp('/private/tmp/amxtr-native-')
const result = { passed: false, privateOnly: true, root, cases: [], cleanupErrors: [] }
async function view(phase) {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/terminal-recovery/vitest.config.mts',
    'apps/desktop/test/terminal-recovery-native-view.test.tsx', '--testNamePattern', 'terminal recovery Native ' + phase, '--reporter=json', '--outputFile=' + receipt + '.' + phase + '.json'], {
    cwd: join(import.meta.dirname, '../../../../..'), env: { ...process.env, AGENTMUX_PRIVATE_TERMINAL_RECOVERY_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
  const [code] = await once(child, 'exit')
  await writeFile(receipt + '.' + phase + '.log', output)
  const report = JSON.parse(await readFile(receipt + '.' + phase + '.json', 'utf8'))
  assert.equal(code, 0, output + JSON.stringify(report.testResults.map(f => ({ message: f.message, tests: f.assertionResults.filter(t => t.status === 'failed') }))))
  assert.equal(report.numPassedTests, 1); assert.equal(report.numFailedTests, 0)
  result.cases.push({ mode: 'actual-Desktop-' + phase, code, passed: report.numPassedTests })
}
async function worker(mode) {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--import', join(import.meta.dirname, 'source-loader.mjs'), join(import.meta.dirname, 'worker.mjs'), mode, root], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const [code, signal] = await once(child, 'exit')
  result.cases.push({ mode, pid: child.pid, code, signal, stdout, stderr })
  assert.equal(code, 0, stderr)
  return stdout.trim() ? JSON.parse(stdout) : null
}
try {
  await mkdir(join(root, 'runtime'), { mode: 0o700 }); await mkdir(join(root, 'state'), { mode: 0o700 })
  const first = await worker('start-lost')
  await view('seed')
  const second = await worker('reenter-cli')
  assert.notEqual(first.pid, second.pid)
  await view('restore')
  result.actual = JSON.parse(await readFile(join(root, 'completed.json'), 'utf8'))
  result.workbench = JSON.parse(await readFile(join(root, 'workbench-restored.json'), 'utf8'))
  result.passed = true
} catch (error) { result.error = error.stack }
finally {
  try { await worker('cleanup') } catch (error) { result.cleanupErrors.push(error.message) }
  try { await stopProbeProcesses(-1, root) } catch (error) { result.cleanupErrors.push(error.message) }
  result.cleaned = result.cleanupErrors.length === 0
  if (result.cleaned) await rm(root, { recursive: true, force: true })
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n')
}
if (!result.passed || !result.cleaned) process.exitCode = 1
