import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { crossHostMutations } from '../test/goal-cross-host-mutations.mjs'
import { prepareLinuxAvatar } from './goal-cross-host-artifact.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? 'product'
const directory = resolve(root, '.local/state/goal-cross-host-verification')
await mkdir(directory, { recursive: true, mode: 0o700 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (mode === 'prepare-native') {
  process.stdout.write(JSON.stringify(await prepareLinuxAvatar(resolve(directory, 'native-cache'), root)) + '\n')
} else if (mode === 'remote-probe') {
  const configuration = JSON.parse(await readFile(process.argv[3], 'utf8'))
  for (const key of ['destination', 'nodePath', 'nativePath']) assert.ok(typeof configuration[key] === 'string' && configuration[key].trim() && !/[\0\r\n]/u.test(configuration[key]), 'Select exact private probe fields')
  assert.ok(configuration.nodePath.startsWith('/') && configuration.nativePath.startsWith('/'))
  assert.ok(!configuration.destination.startsWith('-'))
  const input = JSON.stringify({ node: configuration.nodePath, native: configuration.nativePath })
  const python = `import json, os, hashlib, platform, subprocess, shutil
from pathlib import Path
request=json.loads(${JSON.stringify(input)})
result={'schema':'agentmux.goal-cross-host-remote-probe.v1','system':{'platform':platform.system(),'machine':platform.machine(),'libc':platform.libc_ver()},'freeTmpBytes':shutil.disk_usage('/tmp').free}
for key in ['node','native']:
 p=Path(request[key]); result[key]={'exists':p.is_file(),'executable':os.access(p,os.X_OK)}
 if p.is_file(): result[key]['sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
 if key=='node' and p.is_file(): result[key]['runtime']=json.loads(subprocess.check_output([str(p),'--print','JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})'],text=True))
print(json.dumps(result))
`
  const run = await new Promise((accept, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=8', configuration.destination, 'python3 -'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('close', code => code === 0 ? accept(JSON.parse(stdout)) : reject(Error(stderr)))
    child.stdin.end(python)
  })
  assert.equal(run.node.runtime.platform, 'linux'); assert.equal(run.node.runtime.arch, 'x64')
  assert.ok(Number(run.node.runtime.node.slice(1).split('.')[0]) >= 24)
  assert.equal(run.native.executable, true)
  await writeFile(resolve(directory, 'remote-probe.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify(run) + '\n')
} else if (['core', 'goal', 'product', 'mutations'].includes(mode)) {
  const harnessPaths = ['apps/host/scripts/verify-goal-cross-host.mjs', 'apps/host/test/goal-cross-host-product.test.ts', 'apps/host/test/helpers/goal-cross-host-fixture.ts', 'apps/host/test/goal-cross-host-source.mjs', 'apps/host/test/goal-cross-host-node-loader.mjs', 'apps/host/test/goal-cross-host-mutations.mjs', 'apps/host/test/vitest.goal-cross-host.config.mts', 'pnpm-lock.yaml']
  const harness = async () => Object.fromEntries(await Promise.all(harnessPaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
  const expected = await harness(), runs = [], ownerHashes = new Map()
  for (const label of mode === 'mutations' ? ['baseline', ...Object.keys(crossHostMutations), 'restored'] : [mode]) {
  const mutation = crossHostMutations[label], loaded = resolve(directory, label + '-loaded.jsonl'), result = resolve(directory, label + '-result.json')
  const selected = mutation?.test ?? (mode === 'core' ? 'requires message-purpose|reconciles a committed' : mode === 'goal' ? 'takes a remote worker' : null)
  const expectedPassed = mode === 'core' ? 2 : mode === 'goal' ? 1 : 4
  assert.deepEqual(await harness(), expected, 'The public consumer must stay unchanged across mutations')
  await writeFile(loaded, '')
  const run = await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/host/test/vitest.goal-cross-host.config.mts', ...(selected ? ['-t', selected] : []), '--reporter=json', '--outputFile=' + result], { cwd: root, env: { ...process.env, GOAL_CROSS_HOST_SCOPE: mode, GOAL_CROSS_HOST_LOADED: loaded, GOAL_CROSS_HOST_MUTANT: mutation ? label : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(resolve(directory, label + '.log'), run.output)
  const report = JSON.parse(await readFile(result, 'utf8'))
  const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(await harness(), expected, 'The exact public consumer must stay unchanged during verification')
  assert.equal(run.signal, null)
  assert.equal(report.numTotalTests, 4, 'The exact finite public consumers must be discovered')
  for (const row of evaluations) {
    const key = row.consumer + ':' + row.path, previous = ownerHashes.get(key)
    if (previous) assert.equal(row.originalSHA256, previous, 'The original source candidate changed: ' + key)
    else ownerHashes.set(key, row.originalSHA256)
  }
  if (mutation) {
    assert.notEqual(run.code, 0, 'The changed owning implementation must be detected')
    assert.ok(report.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'A real public assertion must turn red; loader or type errors are not mutation proof')
    assert.ok(evaluations.some(row => row.mutant === label && row.originalSHA256 !== row.loadedSHA256), 'The exact altered owner must actually execute')
  } else {
    assert.equal(run.code, 0, run.output); assert.equal(report.numPassedTests, expectedPassed); assert.equal(report.numPendingTests, 4 - expectedPassed); assert.equal(report.numFailedTests, 0)
  }
  for (const [consumer, path] of [['public-cli', 'packages/core/src/agentmux-cli-commands.ts'], ['host-core', 'packages/core/src/public-rpc-service.ts'], ['host-core', 'apps/host/src/host.ts']]) assert.ok(evaluations.some(row => row.consumer === consumer && row.path === path), 'The actual owner must execute: ' + consumer + ':' + path)
  runs.push({ label, selected, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations })
  process.stdout.write(JSON.stringify({ label, code: run.code, passed: report.numPassedTests, failed: report.numFailedTests, evaluations: evaluations.length }) + '\n')
  }
  const receipt = { schema: 'agentmux.goal-cross-host-product-proof.v1', scope: 'Actual public CLI and two independent semantic Hosts/Runtime identities/File stores with only deterministic Native byte I/O. Separate real SSH proof is required for deployment.', harness: expected, runs }
  await writeFile(resolve(directory, mode + '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
} else throw Error('Use core, goal, product, mutations, or remote-probe <private-probe-config.json>. Actual SSH deployment uses verify-goal-cross-host-ssh.mjs.')
