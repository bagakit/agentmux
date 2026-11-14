import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildHookWorker } from './build-hook-worker.mjs'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/hermes-hook-binding-proof'), mutations = process.argv.includes('--mutations')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-hermes-proof-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = async path => sha(await readFile(path))
const paths = ['src/providers/hermes.ts', 'src/providers/shared.ts', 'src/managed-hook-runtime.ts', 'src/managed-hook-installer.ts',
  'src/hook-config-merge.ts', 'src/hook-server.ts', 'src/agent-hook-command.ts', 'src/agent-hook-delivery.ts', 'dist/agentmux-hook.mjs',
  'test/providers/hermes-hook-binding.native.test.ts', 'test/providers/hermes.test.ts', 'test/fixtures/hermes-native-hooks.py',
  'test/vitest.hermes-hook-binding.config.mts', 'test/vitest.hook-environment.config.mts', 'scripts/verify-hermes-hook-binding.mjs'].map(path => 'packages/core/' + path)
const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, await hash(join(root, path))])))
async function nativePython() {
  let path = (await exec('/bin/sh', ['-c', 'command -v hermes'], { env: { PATH: process.env.PATH } })).stdout.trim()
  assert(path, 'Select the installed Hermes interpreter with AGENTMUX_HERMES_NATIVE_PYTHON')
  for (let depth = 0; depth < 3; depth += 1) {
    const content = await readFile(path, 'utf8'), shebang = content.split('\n')[0]
    if (/^#!\/.*python[^ ]*$/.test(shebang)) {
      const installedPython = shebang.slice(2), venv = dirname(dirname(installedPython)), lib = join(venv, 'lib')
      const versions = (await readdir(lib)).filter(name => /^python\d+\.\d+$/.test(name))
      assert.equal(versions.length, 1, 'Select the exact installed Hermes site-packages')
      const site = join(lib, versions[0], 'site-packages')
      const distributions = (await readdir(site)).filter(name => /^hermes_agent-.*\.dist-info$/.test(name))
      assert.equal(distributions.length, 1)
      const direct = JSON.parse(await readFile(join(site, distributions[0], 'direct_url.json'), 'utf8'))
      assert(direct.dir_info?.editable && direct.url.startsWith('file:'), 'The native proof needs the original installed Hermes package')
      const python = process.env.AGENTMUX_HERMES_NATIVE_PYTHON || await realpath(installedPython)
      await access(python)
      return { python, installedPython, modulePaths: [fileURLToPath(direct.url), site],
        execution: 'Canonical healthy interpreter with original installed modules; virtualenv startup is excluded with -I -S; -B preserves the native source tree.' }
    }
    const target = content.match(/\bexec\s+"([^"\n]+)"\s+"\$@"/)
    assert(target, 'Native Hermes launcher is opaque; select AGENTMUX_HERMES_NATIVE_PYTHON explicitly')
    path = target[1]
  }
  throw Error('Native Hermes launcher did not identify a Python interpreter')
}
try {
  const selection = await nativePython(), python = selection.python
  const home = join(privateRoot, 'home'), nativeHome = join(privateRoot, 'hermes')
  await mkdir(home); await mkdir(nativeHome)
  const env = { PATH: process.env.PATH, HOME: home, HERMES_HOME: nativeHome, HERMES_MANAGED_DIR: join(privateRoot, 'absent-managed'), LANG: 'en_US.UTF-8',
    AGENTMUX_HERMES_NATIVE_MODULE_PATHS: JSON.stringify(selection.modulePaths) }
  const probe = await exec(python, ['-I', '-S', '-B', join(root, 'packages/core/test/fixtures/hermes-native-hooks.py'), '--describe'],
    { env, cwd: privateRoot, timeout: 15_000, maxBuffer: 1024 * 1024 })
  const native = JSON.parse(probe.stdout.trim())
  assert(native.version && native.sources.length === 3, 'Original Hermes package must be available')
  native.python = python; native.selection = selection; native.pythonSHA256 = await hash(python)
  native.pythonVersion = (await exec(python, ['--version'], { env })).stdout.trim()
  native.sourceSHA256 = Object.fromEntries(await Promise.all(native.sources.map(async path => [path, await hash(path)])))
  await buildHookWorker(join(root, 'packages/core'))
  const candidateInputs = await snapshot(), results = []
  const inputs = { ...candidateInputs, [python]: native.pythonSHA256, ...native.sourceSHA256 }
  const workerInput = join(privateRoot, 'original-built-worker.mjs')
  await copyFile(join(root, 'packages/core/dist/agentmux-hook.mjs'), workerInput)
  assert.equal(await hash(workerInput), inputs['packages/core/dist/agentmux-hook.mjs'])
  for (const mutation of mutations ? ['no-retained-runtime', 'allowlist-command-drift', 'no-explicit-shell', 'retire-old-declaration'] : [undefined]) {
    const label = mutation ?? 'positive', loadedPath = join(evidence, label + '.loaded.jsonl'), reportPath = join(evidence, label + '.vitest.json')
    await writeFile(loadedPath, '')
    let result
    try {
      result = { ...(await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
        'packages/core/test/vitest.hermes-hook-binding.config.mts', '--reporter=default', '--reporter=json', '--outputFile=' + reportPath], {
        cwd: root, env: { ...env, AGENTMUX_HERMES_NATIVE_PYTHON: python, AGENTMUX_HERMES_NATIVE_WORKER: workerInput,
          AGENTMUX_HERMES_HOOK_LOADED: loadedPath,
          AGENTMUX_HERMES_NATIVE_RECEIPT: join(evidence, 'native-receipt.json'), ...(mutation ? { AGENTMUX_HERMES_HOOK_MUTATION: mutation } : {}) },
        timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })), code: 0 }
    } catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
    const log = result.stdout + result.stderr; await writeFile(join(evidence, label + '.log'), log)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const assertions = report.testResults.flatMap(file => file.assertionResults ?? [])
    assert(report.numTotalTests > 0 && !(report.unhandledErrors ?? []).length && (report.numRuntimeErrorTestSuites ?? 0) === 0)
    assert(!/Unhandled Errors|Unhandled Rejection|Uncaught Exception/.test(log), 'Unhandled failures cannot qualify the proof')
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(loaded.length && loaded.every(item => item.originalSHA256 === inputs[item.path]), 'Current Hermes owner was not loaded')
    if (mutation) {
      assert.notEqual(result.code, 0, 'Hermes production mutant survived: ' + mutation)
      assert(loaded.some(item => item.mutation === mutation && item.applied && item.loadedSHA256 !== item.originalSHA256))
      const failed = assertions.filter(item => item.status === 'failed')
      assert(report.numFailedTests > 0 && failed.length > 0 && failed.every(item => item.failureMessages?.some(message => /AssertionError/.test(message))),
        'A loader, timeout or resource failure is not semantic mutation RED')
    } else {
      assert.equal(result.code, 0, log); assert(report.numPassedTests > 0 && report.numFailedTests === 0)
      const receipt = JSON.parse(await readFile(join(evidence, 'native-receipt.json'), 'utf8'))
      for (const key of ['actualNativeLoader', 'nativeShellFalse', 'oldOwnedCallbackPreserved', 'observeOnly', 'privateSourceRemoved', 'stableDeclarationUnchanged']) assert.equal(receipt[key], true)
      assert.equal(receipt.observedEvents, 18); assert.equal(receipt.outsideIngress, false); assert.equal(receipt.missingRuntimeIngress, false)
      for (const item of Object.values(receipt.nativeSource)) assert.equal(item.sha256, native.sourceSHA256[item.path])
    }
    results.push({ label, assertions: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, qualified: true,
      semanticRed: !!mutation, loaded, reportSHA256: await hash(reportPath) })
    process.stdout.write(label + ': passed\n')
  }
  assert.deepEqual(await snapshot(), candidateInputs, 'Hermes production or proof inputs changed during qualification')
  assert.equal(await hash(python), native.pythonSHA256, 'Native Python changed during qualification')
  for (const [path, value] of Object.entries(native.sourceSHA256)) assert.equal(await hash(path), value, 'Native source changed during qualification')
  await writeFile(join(evidence, mutations ? 'mutations.json' : 'positive.json'), JSON.stringify({ schema: 'agentmux.hermes-native-hook-proof.v1', passed: true,
    inputs, native, assertions: results.reduce((sum, value) => sum + value.assertions, 0), results,
    ...(mutations ? {} : { nativeReceiptSHA256: await hash(join(evidence, 'native-receipt.json')) }),
    scope: 'Installed Hermes non-shell config/consent/dispatch → retained source-removed worker → original authenticated HookServer; no model and no Core.createAgent.' }, null, 2) + '\n', { mode: 0o600 })
} finally { await rm(privateRoot, { recursive: true, force: true }) }
