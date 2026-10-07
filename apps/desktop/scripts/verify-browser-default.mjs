import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const output = join(repository, '.local/browser-default/proof')
const files = ['browser-default.test.ts', 'web-url-ingress.test.ts', 'browser-default-settings.test.tsx', 'survey-system-url.test.ts'].map(name => 'apps/desktop/test/' + name)
const hash = value => createHash('sha256').update(value).digest('hex')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const sourceFiles = [
  'packages/core/src/browser-default.ts', 'packages/core/src/control.ts', 'packages/core/src/control-codec.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/settings-cli.ts',
  'apps/desktop/src/main/browser-default.ts', 'apps/desktop/src/main/web-url-ingress.ts', 'apps/desktop/src/main/index.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/control-ipc-bridge.ts', 'apps/desktop/src/main/ipc-sender-trust.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/system-web-url.ts',
  'apps/desktop/src/renderer/src/lib/survey-system-url.ts', 'apps/desktop/src/renderer/src/lib/survey-browser-creation.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/settings/DefaultBrowserSetting.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/survey.tsx', 'apps/desktop/scripts/package-macos.mjs',
  'packages/core/dist/browser-default.js', 'packages/core/dist/control-codec.js', 'packages/core/dist/public-rpc.js',
  ...files
]
async function manifest() { return Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(repository, path)))]))) }
async function run(args, log) {
  return await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', ...args, '--maxWorkers=1'], {
      cwd: repository, env: { ...process.env, pnpm_config_verify_deps_before_run: 'warn' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = '', interruption = null, grace
    const timeout = setTimeout(() => {
      interruption = 'timeout'; child.kill('SIGTERM')
      grace = setTimeout(() => child.kill('SIGKILL'), 1_500)
    }, 90_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { clearTimeout(timeout); clearTimeout(grace); no(error) })
    child.once('close', async (code, signal) => { clearTimeout(timeout); clearTimeout(grace); try { await writeFile(log, stdout + stderr); yes({ code, signal, interruption }) } catch (error) { no(error) } })
  })
}
await mkdir(output, { recursive: true })
if (process.argv.includes('--os')) {
  const appIndex = process.argv.indexOf('--app')
  assert(appIndex >= 0 && process.argv[appIndex + 1], 'OS proof requires --app <exact non-installed production application>')
  const { verifyDefaultBrowserOs } = await import('./verify-browser-default-os.mjs')
  const result = await verifyDefaultBrowserOs({ repository, appPath: process.argv[appIndex + 1], output })
  process.stdout.write(JSON.stringify({ status: result.receipt.status, evidence: result.evidence, visualReview: result.receipt.visualReview }) + '\n')
  process.exit(0)
}
const before = await manifest(), receipt = { schema: 'agentmux.browser-default-proof.v1', runId: randomUUID(), status: 'running',
  candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  verifierSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceInputs: before, runs: [] }
async function writeReceipt() {
  const temporaryReceipt = join(output, 'receipt-' + receipt.runId + '.tmp')
  await writeFile(temporaryReceipt, JSON.stringify(receipt, null, 2) + '\n')
  await rename(temporaryReceipt, join(output, 'receipt.json'))
}
await writeReceipt()
const temporary = await mkdtemp(join(output, 'isolated-'))
try {
  async function check(name, change) {
    const jsonPath = join(output, name + '.json'), logPath = join(output, name + '.log')
    let config = `import base from ${JSON.stringify(join(repository, 'vitest.config.ts'))};\nimport { mergeConfig } from 'vitest/config';\n`
    let variant
    if (change) {
      const sourcePath = join(repository, change.path), original = await readFile(sourcePath, 'utf8')
      assert(original.split(change.from).length === 2, name + ': mutation anchor must occur exactly once')
      let content = original.replace(change.from, change.to)
      // Only these two relative imports leave this copied Renderer owner. Runtime logic remains the actual source.
      if (change.path.endsWith('survey-system-url.ts')) {
        for (const specifier of ['../../../shared/scratch-topics', '../../../shared/system-web-url']) {
          assert(content.split(`'${specifier}'`).length === 2, 'The private owner dependency must be exact')
          content = content.replace(`'${specifier}'`, JSON.stringify(resolve(dirname(sourcePath), specifier) + '.ts'))
        }
      }
      const copied = join(temporary, name + '.ts'), loaded = join(output, name + '-loaded.jsonl')
      content += `\nimport { appendFileSync as __proofAppend, readFileSync as __proofRead } from 'node:fs';\nimport { createHash as __proofHash } from 'node:crypto';\n__proofAppend(${JSON.stringify(loaded)}, JSON.stringify({ path: ${JSON.stringify(copied)}, sha256: __proofHash('sha256').update(__proofRead(${JSON.stringify(copied)})).digest('hex') })+'\\n');\n`
      await writeFile(copied, content); await writeFile(loaded, '')
      variant = { original: hash(original), transformed: hash(content), path: copied, loaded, expectedFailure: change.test }
      config += `import { resolve, dirname } from 'node:path';\nconst source = ${JSON.stringify(sourcePath.replace(/\.ts$/, ''))};\n`
      config += `const plugin = { name: 'browser-default-exact-owner-input', enforce: 'pre', resolveId(id, importer) { if(id==='@agentmux/core' && importer===${JSON.stringify(copied)}) return ${JSON.stringify(join(repository, 'packages/core/dist/index.js'))}; if(id==='electron' && importer===${JSON.stringify(copied)}) return ${JSON.stringify(require.resolve('electron'))}; const candidate=id.startsWith('.') && importer ? resolve(dirname(importer),id) : id; if(candidate.replace(/\\.(?:[cm]?[jt]sx?)$/, '')===source) return ${JSON.stringify(copied)}; } };\n`
    }
    config += `export default mergeConfig(base, { ${variant ? 'plugins: [plugin],' : ''} test: { reporters: ['json'], outputFile: ${JSON.stringify(jsonPath)} } });\n`
    const configPath = join(temporary, name + '.config.mjs'); await writeFile(configPath, config)
    const result = await run(['--config', configPath, ...files], logPath)
    const report = JSON.parse(await readFile(jsonPath, 'utf8'))
    const assertions = report.testResults.flatMap(file => file.assertionResults)
    const actualFiles = report.testResults.map(file => file.name).sort()
    assert(JSON.stringify(actualFiles) === JSON.stringify(files.map(file => join(repository, file)).sort()), name + ': exact consumer file set must be nonempty and unique')
    assert(result.interruption === null, name + ': an interrupted test process is not a product result')
    assert(assertions.length === 22, name + ': exact actual consumer cases were not collected')
    if (!variant) assert(result.code === 0 && report.numFailedTests === 0 && assertions.every(test => test.status === 'passed'), name + ': source consumers must all pass')
    else {
      const loads = (await readFile(variant.loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(loads.length === 1 && loads.every(load => load.path === variant.path && load.sha256 === variant.transformed), name + ': exact private source did not load once')
      assert(result.code !== 0 && result.signal === null && assertions.some(test => test.fullName.includes(variant.expectedFailure) && test.status === 'failed'), name + ': expected actual consumer must be RED; environment/suite errors do not count')
      result.loaded = loads
    }
    assert(JSON.stringify(await manifest()) === JSON.stringify(before), name + ': original source or compiled inputs changed during proof')
    receipt.runs.push({ name, ...result, total: assertions.length, passed: report.numPassedTests, failed: report.numFailedTests, variant: variant ?? null })
    await writeReceipt()
    process.stdout.write(`${name}: ${variant ? 'expected consumer RED' : 'GREEN'} (${assertions.length} cases)\n`)
  }
  await check('source')
  if (process.argv.includes('--mutations')) {
    await check('handler-facts-removed', { path: 'apps/desktop/src/main/browser-default.ts', from: 'isCurrentApplication: app.isDefaultProtocolClient(scheme)', to: 'isCurrentApplication: true', test: 'real Core SDK and built CLI consume the same native inspection and explicit request owner' })
    await check('native-settings-request-removed', { path: 'apps/desktop/src/main/browser-default.ts', from: '  await port.openSettings()', to: '  /* exact native settings request removed by private mutation */', test: 'keeps an observation failure unknown and the independent settings request usable' })
    await check('survey-creation-disconnected', { path: 'apps/desktop/src/renderer/src/lib/survey-system-url.ts', from: "await get().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: request.url, preparation: null, onPrepared(value) { preparation = value } })", to: "await Promise.reject(new Error('Private mutation disconnected original Survey creation'))", test: 'the system URL consumer uses the real Survey preparation and exact Scratch Browser creation without changing the original page' })
    await check('restored-source')
  }
  receipt.status = 'passed'; await writeReceipt()
} catch (error) {
  receipt.status = 'failed'; receipt.error = { name: error.name, message: error.message }; await writeReceipt(); throw error
} finally { await rm(temporary, { recursive: true, force: true }) }
