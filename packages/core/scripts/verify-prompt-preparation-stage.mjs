import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { qualifySharedMainSource } from './qualify-shared-main-source.mjs'

const execute = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url))
const core = join(root, 'packages/core'), evidence = join(root, '.tmp/verify-prompt-preparation-stage')
const options = process.argv.slice(2)
assert(options.every(option => ['--source', '--mutations'].includes(option)), 'Unknown preparation-stage proof option')
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = argv => execute(process.execPath, argv, { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
const tests = () => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(core, 'scripts/initial-transport-preparation.vitest.config.mts')])
const build = async () => { const result = await run([join(core, 'scripts/build.mjs')]); await writeFile(join(evidence, 'build.log'), result.stdout + result.stderr) }
const selected = ['packages/core/src', 'packages/demand/src', 'packages/relay/src', 'packages/core/package.json', 'packages/core/tsconfig.json',
  'packages/core/tsconfig.build.json', 'packages/core/scripts/build.mjs', 'packages/core/scripts/qualify-shared-main-source.mjs',
  'packages/core/scripts/verify-prompt-preparation-stage.mjs', 'packages/core/scripts/initial-transport-preparation.vitest.config.mts',
  'packages/core/test/initial-transport-preparation.test.ts', 'packages/core/test/initial-transport-provider.test.ts',
  'packages/core/scripts/immediate-prompt.vitest.config.mts', 'packages/core/test/immediate-prompt.test.ts',
  'packages/core/test/immediate-provider.test.ts', 'packages/core/test/immediate-screen-recovery.test.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/hosted-runtime-port.ts', 'packages/demand/package.json',
  'packages/demand/tsconfig.build.json', 'packages/relay/package.json', 'packages/relay/tsconfig.json', 'tsconfig.base.json', 'pnpm-lock.yaml']
const collect = async (path, entries) => {
  const children = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code !== 'ENOTDIR') throw error; return null })
  if (children) for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) await collect(join(path, child.name), entries)
  else entries[relative(root, path)] = sha(await readFile(path))
}
const source = async () => { const entries = {}; for (const path of selected) await collect(join(root, path), entries); return entries }
const report = { schema: 'agentmux.prompt-preparation-stage.v1', passed: false, callers: [], mutations: [] }
try {
  report.sharedMain = await qualifySharedMainSource(root, selected)
  report.base = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  report.sourceInputs = await source()
  const sdk = await realpath(join(core, 'node_modules/@ctxmux/sdk'))
  report.sdk = { realPath: sdk, entrySha256: sha(await readFile(join(sdk, 'dist/index.js'))), typesSha256: sha(await readFile(join(sdk, 'dist/index.d.ts'))) }
  await build(); report.build = true
  for (const [path, patterns] of [
    ['packages/core/src/client.ts', [/this\.promptSubmission\.qualifyInputTransport\(/u, /if \(preparationStarted\) throw promptPreparationFailure\(error\)/u]],
    ['packages/core/src/hosted-runtime-service.ts', [/invocation\.method === 'submitAgentPrompt'/u, /operation\.apply\(this\.client, invocation\.args\)/u]],
    ['packages/core/src/hosted-client-contract.ts', [/'submitAgentPrompt'/u]],
    ['packages/core/src/public-rpc-service.ts', [/recipientOwner\.client\.submitAgentMessage\(/u, /recordGlobalMessageDeliveryIssue\(/u]],
    ['packages/core/src/public-rpc-client.ts', [/rpcResponseError\(response\)/u]],
    ['packages/core/src/public-rpc-frame.ts', [/controlFailure: parseRpcControlFailure\(source\.controlFailure\)/u, /data\?\.controlFailure === undefined \? undefined : parseRpcControlFailure/u]],
    ['packages/core/src/agentmux.ts', [/controlFailure: source\.controlFailure/u, /detail: source\.detail/u]],
    ['packages/core/src/agentmux-cli-commands.ts', [/'agent\.send'/u]]
  ]) {
    const text = await readFile(join(root, path), 'utf8')
    for (const pattern of patterns) assert(pattern.test(text), `Missing production caller ${path}: ${pattern}`)
    report.callers.push({ file: path, witnesses: patterns.length })
  }
  assert.equal(report.callers.length, 8, 'Empty production caller collection cannot qualify')
  const typeConfig = join(evidence, 'typecheck.json')
  await writeFile(typeConfig, JSON.stringify({ extends: join(core, 'tsconfig.json'), compilerOptions: { noEmit: true, composite: false, rootDir: root },
    include: ['initial-transport-preparation', 'initial-transport-provider', 'immediate-prompt', 'immediate-provider', 'immediate-screen-recovery'].map(name => join(core, 'test', name + '.test.ts')), exclude: [] }, null, 2))
  const types = await run([join(root, 'node_modules/typescript/bin/tsc'), '--project', typeConfig]); await writeFile(join(evidence, 'types.log'), types.stdout + types.stderr); report.owningTypes = true
  const green = await tests(); await writeFile(join(evidence, 'tests.log'), green.stdout + green.stderr)
  assert(/30 passed/u.test(green.stdout)); report.tests = 30
  if (options.includes('--mutations')) {
    for (const [name, file, needle, replacement, compiled] of [
      ['fresh-preparation-phase', 'src/prompt-submission.ts', 'throw promptPreparationFailure(error)', "throw new AgentMuxError('unknown', 'AGENT_PROMPT_IMMEDIATE_CONTEXT_UNCONFIRMED')", true],
      ['outer-cancellation-phase', 'src/client.ts', 'if (preparationStarted) throw promptPreparationFailure(error)', 'if (false) throw promptPreparationFailure(error)', false],
      ['input-attempt-is-not-preparation', 'src/prompt-submission.ts', 'inputAttempted = true', 'inputAttempted = false', false],
      ['original-rejoin-is-not-fresh', 'src/prompt-submission.ts', '!rejoiningOriginal && !inputAttempted', '!inputAttempted', false],
      ['invocation-zero-fact', 'src/prompt-submission.ts', "{ disposition: 'not_applied', confirmedInputBytes: 0 }", "{ disposition: 'unknown', confirmedInputBytes: null }", true],
      ['original-cause-preserved', 'src/prompt-submission.ts', 'return JSON.stringify(cause)', 'return JSON.stringify({ code: "unknown" })', true],
      ['unknown-control-facts-preserved', 'src/prompt-submission.ts', 'error instanceof AgentMuxError ? error.controlFailure : undefined', 'undefined', false],
      ['rpc-control-facts-preserved', 'src/public-rpc-frame.ts', 'controlFailure: parseRpcControlFailure(source.controlFailure)', 'controlFailure: undefined', true],
      ['cli-control-facts-preserved', 'src/agentmux.ts', 'controlFailure: source.controlFailure', 'controlFailure: undefined', true]
    ]) {
      const path = join(core, file), original = await readFile(path, 'utf8')
      assert(original.includes(needle), `Mutation target is absent: ${name}`)
      const mutated = original.replace(needle, replacement)
      try {
        await writeFile(path, mutated)
        if (compiled) await build()
        let red
        try { const result = await tests(); red = { code: 0, stdout: result.stdout, stderr: result.stderr } }
        catch (error) { red = error }
        await writeFile(join(evidence, `mutation-${name}.log`), red.stdout + red.stderr)
        assert.notEqual(red.code, 0, `Survived production mutation ${name}`)
        assert(/\d+ failed/u.test(red.stdout + red.stderr), `Mutation did not reach an owning assertion: ${name}`)
        report.mutations.push({ name, file, killed: true, originalSha256: sha(original), mutatedSha256: sha(mutated) })
      } finally {
        const temporary = `${path}.t012-restore-${process.pid}`
        await writeFile(temporary, original); await rename(temporary, path)
        if (compiled) await build()
      }
    }
    const restored = await tests(); assert(/30 passed/u.test(restored.stdout)); await writeFile(join(evidence, 'restored.log'), restored.stdout + restored.stderr)
  }
  assert.deepEqual(await source(), report.sourceInputs, 'Source changed during its proof')
  report.passed = true
} catch (error) {
  report.error = { message: String(error), code: error.code, stdout: error.stdout, stderr: error.stderr }
  process.exitCode = 1
} finally { await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n') }
process.stdout.write(JSON.stringify({ passed: report.passed, tests: report.tests, mutations: report.mutations.length, callers: report.callers.length, evidence, error: report.error?.message }) + '\n')
