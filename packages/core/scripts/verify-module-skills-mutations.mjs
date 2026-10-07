import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

// One exact private source/artifact snapshot; no shared source/dist mutations or Native build.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.argv[2] ?? join(root, '.tmp/goal-responsibility/t002/mutations'))
await mkdir(output, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = [
  'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-help.ts',
  'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/agentmux-cli-shared-guides.ts',
  'packages/core/src/goal-role-guidance.ts', 'packages/core/src/agentmux-pmo-playbook.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-browser-guide.ts',
  'packages/core/src/agentmux-cli-resource-guide.ts', 'packages/core/src/agentmux-cli-note-guide.ts',
  'packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/browser-page-capability.ts',
  'packages/core/test/agentmux-cli-module-skills.test.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
  'packages/core/package.json', 'packages/core/bin/amux'
]
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await readFile(join(root, file)))])))
const privateRoot = await mkdtemp(join(output, 'private-'))
const receipt = { schema: 'agentmux.module-skills-mutations.v1', passed: false, inputs,
  boundary: 'Actual compiled CLI subprocesses and local module/help owner. Socket connection trap, dead endpoint and unchanged isolated user files prove read behavior. Literal-data writes use a transport-only probe which applies no business writes. No installed App, Native Runtime or live-model adoption claim.',
  privateRoot: relative(root, privateRoot), baseline: null, mutations: [], restored: null, cleanup: null }

const mutations = [
  { id: 'module-owner-lookup', file: 'packages/core/src/agentmux-cli-module-skills.ts',
    from: 'const definition = definitions[root]!', to: 'const definition = definitions.goal!',
    failure: 'actual compiled CLI reads every selected module' },
  { id: 'module-directory-omission', file: 'packages/core/src/agentmux-cli-module-skills.ts',
    from: 'return registeredRoots().map(root => {', to: 'return registeredRoots().slice(1).map(root => {',
    failure: 'actual compiled base discovery lists roots' },
  { id: 'module-local-routing-removed', file: 'packages/core/src/agentmux.ts',
    from: "if (args.length === 2 && args[1] === '--skill') {", to: 'if (false) {',
    failure: 'actual compiled CLI reads every selected module' },
  { id: 'module-routing-consumes-literal', file: 'packages/core/src/agentmux.ts',
    from: "if (args.length === 2 && args[1] === '--skill') {", to: "if (args.includes('--skill')) {",
    failure: 'actual compiled CLI keeps literal --skill input on the original command route' }
]

async function execute(name, red = false, owner = undefined, compiledSha256 = undefined) {
  const report = join(output, `${name}.json`), loaded = join(output, `${name}.loads.jsonl`)
  const config = join(output, `${name}.config.mts`), hook = join(output, `${name}.loader.mjs`)
  const captured = ['agentmux.js', 'agentmux-cli-module-skills.js', 'agentmux-cli-help.js', 'goal-role-guidance.js']
    .map(file => pathToFileURL(join(privateRoot, 'packages/core/dist', file)).href)
  await writeFile(config, `import {defineConfig} from 'vitest/config';export default defineConfig({root:${JSON.stringify(privateRoot)},test:{include:['packages/core/test/agentmux-cli-module-skills.test.ts'],passWithNoTests:false,maxWorkers:1}})\n`)
  await writeFile(hook, `import {registerHooks} from 'node:module';import {appendFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';const captured=new Set(${JSON.stringify(captured)});registerHooks({load(url,context,next){const result=next(url,context);if(captured.has(url)){const file=fileURLToPath(url);appendFileSync(${JSON.stringify(loaded)},JSON.stringify({file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')})+'\\n')}return result}});\n`)
  const { code, text } = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile', report], { cwd: privateRoot, env: { ...process.env,
      pnpm_config_verify_deps_before_run: 'false',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(hook).href}`.trim() }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', chunk => { text += chunk })
    child.stderr.on('data', chunk => { text += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, text }))
  })
  const log = join(output, `${name}.log`)
  await writeFile(log, text)
  const reportBytes = await readFile(report), data = JSON.parse(reportBytes)
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  const loadsBytes = await readFile(loaded), loads = loadsBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(assertions.length > 0, name + ': owning suite must not be empty')
  assert.equal(assertions.length, data.numTotalTests)
  assert.equal(data.numPendingTests, 0)
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, name + ': preparation/collection errors are not semantic RED')
  assert.equal(code, red ? 1 : 0, text.slice(-5000))
  const failures = assertions.filter(test => test.status === 'failed')
  const businessFailure = owner ? failures.find(test => test.fullName.includes(owner.failure) &&
    test.failureMessages.some(message => message.includes('AssertionError'))) : undefined
  if (red) {
    assert.ok(businessFailure, name + ': the designated product assertion must fail')
    const compiled = join(privateRoot, owner.file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))
    assert.ok(loads.some(load => load.file === compiled && load.sha256 === compiledSha256), name + ': actual CLI must load the exact compiled mutant')
  } else assert.equal(data.numFailedTests, 0, text.slice(-5000))
  assert.ok(loads.some(load => load.file === join(privateRoot, 'packages/core/dist/agentmux.js')))
  return { exitCode: code, total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests,
    businessAssertionRed: businessFailure?.fullName ?? null,
    report: relative(root, report), reportSha256: sha(reportBytes), log: relative(root, log), logSha256: sha(text),
    loaded: relative(root, loaded), loadedSha256: sha(loadsBytes),
    compiledCliSha256: sha(await readFile(join(privateRoot, 'packages/core/dist/agentmux.js'))) }
}

let problem
try {
  const sourceStats = await Promise.all((await readdir(join(root, 'packages/core/src'), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => stat(join(entry.parentPath, entry.name))))
  const artifactStats = await Promise.all((await readdir(join(root, 'packages/core/dist'), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => stat(join(entry.parentPath, entry.name))))
  assert.ok(sourceStats.length > 0 && artifactStats.length > 0)
  assert.ok(Math.min(...artifactStats.map(item => item.mtimeMs)) > Math.max(...sourceStats.map(item => item.mtimeMs)),
    'Build current Core source before taking the exact compiled snapshot; stale output is not qualification.')
  for (const file of ['packages/core/src', 'packages/core/dist', 'packages/core/bin', 'packages/core/package.json',
    'packages/core/test/agentmux-cli-module-skills.test.ts', 'packages/core/test/helpers/object-cli-rpc.ts']) {
    const target = join(privateRoot, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true })
  }
  for (const file of ['node_modules', 'packages/core/node_modules']) {
    const target = join(privateRoot, file)
    await mkdir(dirname(target), { recursive: true })
    await symlink(join(root, file), target)
  }
  receipt.baseline = await execute('baseline')
  for (const mutation of mutations) {
    const sourceFile = join(privateRoot, mutation.file)
    const compiledFile = join(privateRoot, mutation.file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))
    const original = await readFile(sourceFile, 'utf8'), originalCompiled = await readFile(compiledFile)
    assert.equal(original.split(mutation.from).length - 1, 1, mutation.id + ': mutation anchor must be unique')
    const candidate = original.replace(mutation.from, mutation.to)
    // Compile only this exact TypeScript target. Compilation failure aborts; it never counts RED.
    const artifact = (await transform(candidate, { loader: 'ts', format: 'esm', target: 'node24', sourcefile: mutation.file })).code
    const candidateFile = join(output, `${mutation.id}.source.ts`), artifactFile = join(output, `${mutation.id}.compiled.js`)
    await writeFile(candidateFile, candidate)
    await writeFile(artifactFile, artifact)
    let red
    try {
      await writeFile(sourceFile, candidate)
      await writeFile(compiledFile, artifact)
      red = await execute(mutation.id, true, mutation, sha(artifact))
    } finally {
      await writeFile(sourceFile, original)
      await writeFile(compiledFile, originalCompiled)
    }
    const green = await execute(`${mutation.id}-restored`)
    assert.equal(red.total, receipt.baseline.total)
    assert.equal(green.total, receipt.baseline.total)
    receipt.mutations.push({ id: mutation.id, file: mutation.file, sourceSha256: sha(original),
      transformedSource: relative(root, candidateFile), transformedSourceSha256: sha(candidate),
      compiledOwner: relative(root, artifactFile), compiledOwnerSha256: sha(artifact), red, green })
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    process.stdout.write(`${mutation.id}: bound actual CLI semantic RED -> restored GREEN\n`)
  }
  receipt.restored = await execute('restored')
  for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(join(root, file))), hash,
    file + ': input changed during qualification; this evidence is only for the recorded snapshot')
  assert.equal(receipt.mutations.length, mutations.length)
  receipt.passed = true
} catch (error) { problem = error; receipt.error = String(error) }
finally {
  await rm(privateRoot, { recursive: true, force: true })
  receipt.cleanup = { privateCopyRemoved: true, sharedSourceOrDistMutations: 0, retainedEvidence: relative(root, output) }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
if (problem) throw problem
process.stdout.write(`All ${receipt.mutations.length} local module lookup/routing mutants caused product assertions RED; restored suite ${receipt.restored.passed}/${receipt.restored.total} GREEN.\n`)
