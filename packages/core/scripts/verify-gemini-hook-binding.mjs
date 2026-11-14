import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const cli = await realpath(process.env.AGENTMUX_GEMINI_NATIVE_BINARY ||
  (await exec('/bin/sh', ['-c', 'command -v gemini'], { env: { PATH: process.env.PATH } })).stdout.trim())
const cliSource = await readFile(cli, 'utf8'), bundle = dirname(cli)
const manifestPath = join(dirname(bundle), 'package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.name, '@google/gemini-cli', 'Select the original installed Gemini CLI package')
// Some installations retain obsolete core-*.js barrels. Select the actual current CLI's
// direct import of its Hook owner, rather than choosing a similarly named cached artifact.
const modules = []
for (const [, relative] of cliSource.matchAll(/import\s+["'](\.\/[^"']+\.js)["']/gu)) {
  const path = resolve(bundle, relative), source = await readFile(path, 'utf8')
  if (/var HookSystem = class/u.test(source) && /var Config = class/u.test(source)) modules.push({ path, sha256: sha(source) })
}
assert.equal(modules.length, 1, 'The selected current CLI must identify one actual Config/HookSystem owner')
const native = { cli, cliSHA256: sha(cliSource), package: manifest.name, version: manifest.version,
  manifestSHA256: sha(await readFile(manifestPath)), module: modules[0].path, moduleSHA256: modules[0].sha256 }
const evidence = join(root, '.local/state/gemini-hook-binding-proof')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-gemini-proof-'))
await mkdir(join(privateRoot, 'home')); await mkdir(join(privateRoot, 'tmp'))
const env = { PATH: '/usr/bin:/bin', HOME: join(privateRoot, 'home'), GEMINI_CLI_HOME: join(privateRoot, 'home'),
  TMPDIR: join(privateRoot, 'tmp'), LANG: 'en_US.UTF-8',
  AGENTMUX_GEMINI_NATIVE_MODULE: pathToFileURL(native.module).href,
  AGENTMUX_GEMINI_NATIVE_RECEIPT: join(evidence, 'native-receipt.json') }
try {
  if (process.argv.includes('--preflight')) {
    const code = `const {Config,HookSystem}=await import(process.argv[1]);const c=new Config({sessionId:'00000000-0000-4000-8000-000000000111',targetDir:process.cwd(),cwd:process.cwd(),debugMode:false,model:'private-no-inference',hooks:{BeforeAgent:[{hooks:[{type:'command',command:"printf '{}'",timeout:5000}]}]},trustedFolder:true,folderTrust:false,mcpEnabled:false,enableHooks:true});await c.storage.initialize();const h=new HookSystem(c);await h.initialize();const r=await h.getEventHandler().fireBeforeAgentEvent('private-preflight');if(!r.success||r.errors.length||h.getAllHooks().length!==1)throw Error('Actual native Hook loader failed');console.log('PRIVATE_NATIVE_PREFLIGHT_PASSED');`
    const args = process.platform === 'darwin' ? ['-p', '(version 1)(allow default)(deny network*)', process.execPath,
      '--input-type=module', '-e', code, env.AGENTMUX_GEMINI_NATIVE_MODULE] : ['--input-type=module', '-e', code, env.AGENTMUX_GEMINI_NATIVE_MODULE]
    const result = await exec(process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : process.execPath, args,
      { env, cwd: privateRoot, timeout: 20_000, maxBuffer: 1024 * 1024 })
    assert(result.stdout.includes('PRIVATE_NATIVE_PREFLIGHT_PASSED'))
    await writeFile(join(evidence, 'preflight.json'), JSON.stringify({ native, passed: true, scope: 'real native Config/Storage/HookSystem executes a passive command without networking or model input' }, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ native, preflight: true, passed: true }) + '\n')
  } else {
    const compiler = ts.convertCompilerOptionsFromJson(JSON.parse(await readFile(join(root, 'tsconfig.base.json'), 'utf8')).compilerOptions, root).options
    const workerPath = 'packages/core/dist/agentmux-hook.mjs', workerSHA256 = sha(await readFile(join(root, workerPath)))
    const fixtureHashes = {}
    for (const path of ['packages/core/test/providers/gemini-hook-binding.native.test.ts',
      'packages/core/test/fixtures/gemini-hook-native-host.mjs', 'packages/core/scripts/verify-gemini-hook-binding.mjs']) fixtureHashes[path] = sha(await readFile(join(root, path)))
    const owners = ['providers/gemini', 'providers/shared', 'hook-server', 'managed-hook-runtime', 'managed-hook-installer', 'hook-config-merge']
    const compiled = {}
    for (const owner of owners) {
      const sourcePath = join(root, 'packages/core/src', owner + '.ts'), artifactPath = join(root, 'packages/core/dist', owner + '.js')
      const source = await readFile(sourcePath, 'utf8'), artifact = await readFile(artifactPath, 'utf8')
      const emitted = ts.transpileModule(source, { fileName: sourcePath, compilerOptions: { ...compiler,
        module: ts.ModuleKind.ESNext, sourceMap: false, inlineSourceMap: false, declaration: false } }).outputText
      assert.equal(artifact.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), emitted,
        'Current compiled owner is required before this native proof: ' + owner)
      compiled[owner] = { sourceSHA256: sha(source), artifactSHA256: sha(artifact) }
    }
    const config = join(privateRoot, 'native.config.mts'), reportPath = join(evidence, 'vitest.json')
    await writeFile(config, `export default ${JSON.stringify({ root, cacheDir: join(privateRoot, 'cache'), test: {
      environment: 'node', globalSetup: [], setupFiles: [], passWithNoTests: false, maxWorkers: 1,
      fileParallelism: false, include: ['packages/core/test/providers/gemini-hook-binding.native.test.ts'], testTimeout: 60_000 } })};\n`)
    await rm(env.AGENTMUX_GEMINI_NATIVE_RECEIPT, { force: true })
    let outcome
    try { outcome = { ...(await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env, timeout: 85_000, maxBuffer: 2 * 1024 * 1024 })), code: 0 } }
    catch (error) { outcome = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
    await writeFile(join(evidence, 'native.log'), outcome.stdout + outcome.stderr)
    assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.numTotalTests, 1); assert.equal(report.numPassedTests, 1); assert.equal(report.numFailedTests, 0)
    const receipt = JSON.parse(await readFile(env.AGENTMUX_GEMINI_NATIVE_RECEIPT, 'utf8'))
    assert.equal(receipt.nativeModule, env.AGENTMUX_GEMINI_NATIVE_MODULE)
    assert.equal(receipt.privateRootRemoved, true)
    assert.equal(receipt.eventNames.length, 7)
    assert.equal(receipt.outsideIngress, false); assert.equal(receipt.foreignIngress, false)
    for (const pid of receipt.nativeHostPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.equal(sha(await readFile(native.module)), native.moduleSHA256, 'Installed native artifact changed during proof')
    assert.equal(sha(await readFile(join(root, workerPath))), workerSHA256, 'The bundled Hook worker changed during proof')
    for (const [owner, identity] of Object.entries(compiled)) {
      assert.equal(sha(await readFile(join(root, 'packages/core/src', owner + '.ts'))), identity.sourceSHA256)
      assert.equal(sha(await readFile(join(root, 'packages/core/dist', owner + '.js'))), identity.artifactSHA256)
    }
    for (const [path, identity] of Object.entries(fixtureHashes)) assert.equal(sha(await readFile(join(root, path))), identity,
      'Native proof fixture changed during execution: ' + path)
    const inputs = { [cli]: native.cliSHA256, [manifestPath]: native.manifestSHA256, [native.module]: native.moduleSHA256,
      [workerPath]: workerSHA256, ...fixtureHashes }
    for (const [owner, identity] of Object.entries(compiled)) {
      inputs['packages/core/src/' + owner + '.ts'] = identity.sourceSHA256
      inputs['packages/core/dist/' + owner + '.js'] = identity.artifactSHA256
    }
    await writeFile(join(evidence, 'positive.json'), JSON.stringify({ schema: 'agentmux.gemini-installed-hook-proof.v1', native,
      nativeBinaryPath: cli, nativeBinarySHA256: native.cliSHA256, inputs, compiled, fixtureHashes,
      assertions: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests },
      passed: true, receipt: env.AGENTMUX_GEMINI_NATIVE_RECEIPT,
      scope: 'Installed native Config/Storage/HookSystem; real shell/worker and compiled HookServer bindings; no inference or full CLI Session lifecycle claim' }, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ passed: true, evidence }) + '\n')
  }
} finally { await rm(privateRoot, { recursive: true, force: true }) }
