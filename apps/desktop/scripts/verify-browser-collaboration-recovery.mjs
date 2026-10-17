import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

// One private build of the ordinary product, then the existing two-process lifecycle.
// Saved Browser, spatial, draft, capture and input records are written only by product owners.
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url), exec = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2)
const outputAt = args.indexOf('--output')
const evidence = resolve(outputAt < 0 ? join(root, '.tmp/browser-collaboration-recovery', randomUUID()) : args[outputAt + 1])
assert.ok(args.every((arg, index) => arg === '--output' || outputAt >= 0 && index === outputAt + 1 || arg === '--build-only'), 'Only the explicit output and build-only options are supported')
await mkdir(evidence, { recursive: true })
// Explicit evidence consumption never starts another App or repeats an authored opinion.
if (process.env.AGENTMUX_BROWSER_COLLABORATION_QUALIFIED_INPUT) {
  const inputPath = resolve(process.env.AGENTMUX_BROWSER_COLLABORATION_QUALIFIED_INPUT)
  const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes)
  assert.equal(input.schema, 'agentmux.browser-collaboration-qualified-input.v1')
  const artifacts = {}
  for (const [name, reference] of Object.entries(input.artifacts)) {
    const bytes = await readFile(resolve(root, reference.file))
    assert.equal(sha(bytes), reference.sha256, 'Original evidence remains unchanged: ' + name)
    artifacts[name] = JSON.parse(bytes)
  }
  const { build, native, nativeInputs, mutations, review } = artifacts
  assert.ok(Object.keys(build.sources).length > 0 && Object.keys(build.compiled).length > 0)
  assert.equal(native.sourceCommit, build.candidate)
  assert.equal(native.passed, true); assert.equal(native.completeGate, true)
  assert.equal(native.cleanup.privateProcessesReaped, true); assert.equal(native.cleanup.temporaryRootRemoved, true)
  for (const name of ['browser-collaboration-probe-scenario.mjs', 'verify-browser-recovery-restart.mjs']) {
    const file = 'apps/desktop/scripts/' + name
    assert.equal(nativeInputs.verification[file], sha(await readFile(join(root, file))), 'The original native case executes the current oracle')
  }
  assert.equal(native.collaboration.passed, true)
  assert.equal(native.collaboration.cases.length, 2); assert.ok(native.collaboration.cases.every(value => value.passed))
  assert.equal(native.collaboration.missingCondition.confirmed, true)
  assert.equal(native.collaboration.missingCondition.removeAttempts, 1)
  assert.equal(native.collaboration.missingCondition.statusCode, 'run_not_found')
  assert.equal(review.approved, true)
  for (const name of ['browser-collaboration-probe-scenario.mjs', 'verify-browser-recovery-restart.mjs', 'verify-browser-collaboration-recovery.mjs']) {
    const file = 'apps/desktop/scripts/' + name
    assert.equal(review.reviewedSources[file], sha(await readFile(join(root, file))), 'Independent review matches current verification source')
  }
  const changes = new Map(input.reviewedChanges.map(value => [value.file, value])), changed = []
  for (const [file, before] of Object.entries(build.sources)) {
    const after = sha(await readFile(join(root, file)))
    if (before === after) continue
    const change = changes.get(file)
    assert.ok(change?.reason?.trim(), 'Changed source requires a bounded review: ' + file)
    assert.equal(change.before, before); assert.equal(change.after, after); changed.push(file)
  }
  assert.deepEqual([...changes.keys()].sort(), changed.sort())
  for (const [file, digest] of Object.entries(build.compiled)) assert.equal(sha(await readFile(join(build.product, file))), digest, 'Original compiled product remains restored: ' + file)
  assert.equal(mutations.passed, true); assert.equal(mutations.runs.length, 3)
  for (const [index, run] of mutations.runs.entries()) {
    assert.equal(run.id, ['draft', 'input', 'restored'][index])
    assert.equal(run.sourceSha256, build.sources[run.productionOwner])
    const bytes = await readFile(resolve(root, run.receipt)); assert.equal(sha(bytes), run.sha256)
    const observed = JSON.parse(bytes)
    const verificationBytes = await readFile(resolve(root, run.inputs)); assert.equal(sha(verificationBytes), run.inputsSha256)
    const verification = JSON.parse(verificationBytes).verification
    for (const name of ['browser-collaboration-probe-scenario.mjs', 'verify-browser-recovery-restart.mjs']) {
      const file = 'apps/desktop/scripts/' + name
      assert.equal(verification[file], sha(await readFile(join(root, file))), 'The actual mutant uses the same exact oracle')
    }

    assert.equal(observed.sourceCommit, build.candidate)
    assert.equal(observed.cleanup.privateProcessesReaped, true); assert.equal(observed.cleanup.temporaryRootRemoved, true)
    assert.ok(observed.identityBefore['apps/desktop/out/renderer/' + run.compiledFile])
    assert.equal(observed.identityBefore['apps/desktop/out/renderer/' + run.compiledFile], run.served)
    assert.equal(run.original, build.compiled['apps/desktop/out/renderer/' + run.compiledFile])
    if (index < 2) {
      assert.notEqual(run.served, run.original); assert.equal(run.result, 'owning-AssertionRED')
      assert.equal(observed.passed, false); assert.ok(observed.failure.stack.startsWith('AssertionError'))
      assert.ok(observed.failure.message.includes(run.owningAssertion))
      if (run.assertionLine) assert.ok(observed.failure.stack.includes('browser-collaboration-probe-scenario.mjs:' + run.assertionLine + ':'))
    } else {
      assert.equal(run.served, run.original); assert.equal(run.result, 'GREEN'); assert.equal(observed.passed, true)
      assert.equal(observed.collaboration.missingCondition.confirmed, true)
    }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-collaboration-recovery-qualified.v1',
    passed: true, sourceCandidate: build.candidate, verificationCandidate: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    input: { file: relative(root, inputPath), sha256: sha(inputBytes) }, artifacts: input.artifacts, reviewedChanges: input.reviewedChanges,
    boundary: 'Retained actual ordinary two-process product and same-Session native context recovery, plus two production hydration join mutants and restored GREEN. Original receipts are consumed without another App, message or SDK remove. No installed App, physical input, crash or power-loss claim.' }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json') }) + '\n')
  process.exit(0)
}
const product = await realpath(await mkdtemp(join(tmpdir(), 'amx-bcr-')))
const receipt = { schema: 'agentmux.browser-collaboration-recovery.v1', passed: false, evidence, product, sources: {}, loaded: {}, compiled: {}, runs: [], cleanup: {} }
const packages = ['core', 'demand', 'relay', 'identity', 'git', 'diagnostic-evidence', 'client-ui', 'layout', 'connectors']
const assets = ['packages/core/vendor', 'apps/desktop/vendor', 'apps/desktop/brand', 'apps/desktop/browser-extension']
const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.shared.json', 'patches',
  'apps/desktop/src', 'apps/desktop/scripts', 'apps/desktop/resources', 'apps/desktop/native', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/package.json',
  'apps/host/src', 'apps/host/package.json', 'test/fixture-values.mjs', 'test/fixture-epoch.cjs',
  'packages/core/scripts', 'packages/core/bin', 'packages/core/native', 'packages/core/test/fixtures', 'packages/client-ui/scripts',
  ...packages.flatMap(name => ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json'].map(path => `packages/${name}/${path}`))]
const qa = ['verify-browser-collaboration-recovery.mjs', 'browser-collaboration-probe-scenario.mjs', 'verify-browser-recovery-restart.mjs']
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_)/u.test(key) && !['NODE_OPTIONS', 'CODEX_HOME'].includes(key)))
const command = async (label, executable, argv, cwd = product, extra = {}) => {
  const run = { label, executable, argv, log: join(evidence, label + '.log') }; receipt.runs.push(run)
  try {
    const result = await exec(executable, argv, { cwd, env: { ...env, ...extra }, maxBuffer: 16 * 1024 * 1024 })
    await writeFile(run.log, result.stdout + result.stderr); run.exit = 0
    return result
  } catch (error) {
    await writeFile(run.log, (error.stdout ?? '') + (error.stderr ?? '')); run.exit = error.code ?? null; run.signal = error.signal ?? null
    throw error
  }
}
const record = async (directory, target) => {
  for (const entry of await readdir(join(product, directory), { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name); target[relative(product, path)] = sha(await readFile(path))
  }
}
let failure
try {
  receipt.candidate = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  receipt.sourceMode = 'committed-product-with-explicit-verification-files'
  const tracked = (await exec('git', ['ls-tree', '-r', '--name-only', receipt.candidate, '--', ...inputs], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split('\n')
  const archive = join(product, 'source.tar.gz')
  await command('source-archive', 'git', ['archive', '--format=tar.gz', '--output=' + archive, receipt.candidate, '--', ...inputs.filter(path => tracked.some(file => file === path || file.startsWith(path + '/')))], root)
  await command('source-extract', 'tar', ['-xzf', archive, '-C', product]); await rm(archive)
  for (const path of tracked) receipt.sources[path] = sha(await readFile(join(product, path)))
  // Verification code can be authored independently; its actual bytes are bound separately.
  receipt.verification = {}
  for (const name of qa) {
    const path = 'apps/desktop/scripts/' + name, bytes = await readFile(join(root, path))
    await writeFile(join(product, path), bytes); receipt.verification[path] = sha(bytes)
  }
  for (const path of assets) {
    await mkdir(dirname(join(product, path)), { recursive: true }); await symlink(join(root, path), join(product, path))
  }
  receipt.assets = Object.fromEntries(await Promise.all(assets.map(async path => [path, (await exec('git', ['rev-parse', receipt.candidate + ':' + path], { cwd: root })).stdout.trim()])))
  // Reuse installed dependencies read-only, but all workspace resolutions point inside this build.
  // This prevents a shared @agentmux/core symlink from silently selecting another tree's dist.
  for (const consumer of ['.', 'apps/desktop', 'apps/host', ...packages.map(name => 'packages/' + name)]) {
    const modules = join(product, consumer, 'node_modules'), actual = join(root, consumer, 'node_modules')
    await mkdir(join(modules, '@agentmux'), { recursive: true })
    for (const name of packages) await symlink(join(product, 'packages', name), join(modules, '@agentmux', name))
    for (const entry of await readdir(actual, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      if (['@agentmux', '@ctxmux', '.bin'].includes(entry.name)) continue
      await symlink(join(actual, entry.name), join(modules, entry.name))
    }
  }
  const vendor = join(product, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch)
  const manifestBytes = await readFile(join(vendor, 'manifest.json')), manifest = JSON.parse(manifestBytes)
  const contract = JSON.parse(await readFile(join(product, 'packages/core/src/ctxmux-artifact-contract.json'), 'utf8'))
  assert.equal(sha(manifestBytes), contract.manifests[process.platform + '-' + process.arch])
  const sdkArchive = join(vendor, manifest.sdk.archive.path)
  assert.equal(sha(await readFile(sdkArchive)), manifest.sdk.archive.sha256)
  const sdk = join(product, '.sdk'); await mkdir(sdk); await command('sdk-extract', 'tar', ['-xzf', sdkArchive, '-C', sdk])
  await symlink(join(product, 'packages/core/node_modules'), join(sdk, 'package/node_modules'))
  for (const consumer of ['.', 'apps/desktop', 'apps/host', ...packages.map(name => 'packages/' + name)]) {
    await mkdir(join(product, consumer, 'node_modules/@ctxmux'), { recursive: true })
    await symlink(join(sdk, 'package'), join(product, consumer, 'node_modules/@ctxmux/sdk'))
  }
  const coreRequire = createRequire(join(root, 'packages/core/package.json'))
  const tools = { tsc: coreRequire.resolve('typescript/bin/tsc'), esbuild: coreRequire.resolve('esbuild/bin/esbuild') }
  const toolRoot = join(product, '.tools'); await mkdir(toolRoot)
  await writeFile(join(toolRoot, 'pnpm'), '#!/usr/bin/env node\nconst{execFileSync}=require("node:child_process"),tools=' + JSON.stringify(tools) + ';const[a,b,...rest]=process.argv.slice(2);if(a!=="exec"||!tools[b])throw Error("Unexpected build tool");execFileSync(b==="tsc"?process.execPath:tools[b],b==="tsc"?[tools[b],...rest]:rest,{stdio:"inherit"});\n', { mode: 0o700 })
  env.PATH = toolRoot + ':' + env.PATH
  receipt.tools = Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([key, path]) => [key, { path, sha256: sha(await readFile(path)) }])))
  for (const [name, config] of [['identity', 'tsconfig.json'], ['git', 'tsconfig.build.json'], ['diagnostic-evidence', 'tsconfig.json'], ['demand', 'tsconfig.build.json'], ['relay', 'tsconfig.json']])
    await command(name + '-build', process.execPath, [tools.tsc, '-p', `packages/${name}/${config}`])
  await command('core-build', process.execPath, ['packages/core/scripts/build.mjs'])
  for (const [name, config] of [['client-ui', 'tsconfig.build.json'], ['connectors', 'tsconfig.json']])
    await command(name + '-build', process.execPath, [tools.tsc, '-p', `packages/${name}/${config}`])
  await command('workspace-helper', process.execPath, ['apps/desktop/scripts/build-workspace-move-helper.mjs'])
  const config = join(product, 'apps/desktop/collaboration-proof.vite.config.mjs')
  await writeFile(config, `import actual from './electron.vite.config.ts';import{readFile,writeFile}from'node:fs/promises';import{relative}from'node:path';import{createHash}from'node:crypto';const root=${JSON.stringify(product)},loaded={};const observe=()=>({name:'collaboration-original-product',enforce:'pre',async load(id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?'))try{loaded[relative(root,id)]=createHash('sha256').update(await readFile(id)).digest('hex')}catch{}},async closeBundle(){await writeFile(${JSON.stringify(join(evidence, 'loaded.json'))},JSON.stringify(loaded,null,2))}});export default Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,{...value,plugins:[observe(),...(value.plugins??[])]}]));\n`)
  await command('desktop-build', process.execPath, [join(root, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', config], join(product, 'apps/desktop'))
  await command('renderer-release', process.execPath, ['apps/desktop/scripts/build-renderer-release.mjs'])
  receipt.loaded = JSON.parse(await readFile(join(evidence, 'loaded.json'), 'utf8'))
  for (const path of ['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserContextualComposer.tsx'])
    assert.equal(receipt.loaded[path], receipt.sources[path], 'The complete ordinary App consumes the actual candidate: ' + path)
  for (const path of ['apps/desktop/out', ...packages.filter(name => name !== 'layout').map(name => `packages/${name}/dist`)]) await record(path, receipt.compiled)
  await writeFile(join(evidence, 'build.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (!args.includes('--build-only')) {
    const home = join(product, 'worker-home'); await mkdir(home)
    const runRestart = async (label, mutation) => {
      const inputsPath = join(evidence, label + '-inputs.json'), inputsBytes = JSON.stringify({ verification: receipt.verification })
      await writeFile(inputsPath, inputsBytes)
      let failure
      try { await command(label, process.execPath, [join(product, 'apps/desktop/scripts/verify-browser-recovery-restart.mjs'), '--case-collaboration'], product,
        { HOME: home, AGENTMUX_COLLABORATION_BUILD: join(evidence, 'build.json') }) } catch (error) { failure = error }
      const bytes = await readFile(join(product, '.tmp/browser-collaboration-recovery-last.json')), observed = JSON.parse(bytes)
      assert.equal(observed.cleanup.privateProcessesReaped, true); assert.equal(observed.cleanup.temporaryRootRemoved, true)
      if (mutation) {
        assert.ok(failure); assert.equal(observed.passed, false); assert.ok(observed.failure.stack.startsWith('AssertionError'))
        const source = (await readFile(join(product, 'apps/desktop/scripts/browser-collaboration-probe-scenario.mjs'), 'utf8')).split('\n')
        const lines = mutation.assertions.map(assertion => source.findIndex(row => row.trim() === assertion) + 1)
        assert.ok(lines.every(line => line > 0))
        const line = lines.find(line => observed.failure.stack.includes('browser-collaboration-probe-scenario.mjs:' + line + ':'))
        assert.ok(line, 'Only an owning draft or frozen-input assertion qualifies RED')
        mutation.assertionLine = line
      } else {
        if (failure) throw failure
        assert.equal(observed.passed, true); assert.equal(observed.collaboration.missingCondition.confirmed, true)
      }
      const path = join(evidence, label + '.json'); await writeFile(path, bytes)
      return { observed, reference: { file: path, sha256: sha(bytes) }, inputs: inputsPath, inputsSha256: sha(inputsBytes) }
    }
    receipt.restart = (await runRestart('ordinary-restart')).observed
    const renderer = join(product, 'apps/desktop/out/renderer'), releasePath = join(renderer, 'release.json')
    const releaseBytes = await readFile(releasePath), release = JSON.parse(releaseBytes), matches = []
    for (const name of await readdir(join(renderer, 'assets'))) if (name.endsWith('.js')) {
      const bytes = await readFile(join(renderer, 'assets', name))
      if (bytes.includes(Buffer.from('function partializeAppState'))) matches.push({ file: 'assets/' + name, bytes })
    }
    assert.equal(matches.length, 1)
    const bundle = matches[0], original = bundle.bytes.toString(), anchor = 'const state2 = { ...current2, ...persisted };'
    assert.equal(original.split(anchor).length, 2, 'The actual production hydration merge must occur exactly once')
    const mutations = [
      { id: 'draft', replacement: 'const state2 = { ...current2, ...persisted, browserOpinionDrafts: {} };',
        assertions: ["assert.deepEqual(recovered.state.browserOpinionDrafts[bid], firstSaved.browserOpinionDrafts[bid], 'Original draft and exact processed image survive normal quit')", 'assert.deepEqual(final.browserOpinionDrafts[bid], firstSaved.browserOpinionDrafts[bid])'] },
      { id: 'input', replacement: 'const state2 = { ...current2, ...persisted, agentSteerQueues: Object.fromEntries(Object.entries(persisted?.agentSteerQueues ?? {}).map(([sid, entries]) => [sid, entries.map(entry => entry.browserInput ? {...entry, operationId: crypto.randomUUID()} : entry)])) };',
        assertions: ["assert.ok(sameQueue, 'The second process keeps the exact original queued input identity')", 'assert.equal(final.agentSteerQueues[sid].filter(entry => entry.operationId === queued.operationId).length, 1)'] }
    ], runs = [], proof = { productionOwner: 'apps/desktop/src/renderer/src/store.ts', sourceSha256: receipt.sources['apps/desktop/src/renderer/src/store.ts'], compiledFile: bundle.file, original: sha(bundle.bytes) }
    try {
      for (const mutation of mutations) {
        const served = Buffer.from(original.replace(anchor, mutation.replacement)), next = structuredClone(release)
        next.files[bundle.file] = sha(served)
        next.id = sha(JSON.stringify({ identity: next.identity, files: Object.entries(next.files).sort() }))
        await writeFile(join(renderer, bundle.file), served); await writeFile(releasePath, JSON.stringify(next))
        const observed = await runRestart('join-' + mutation.id, mutation)
        runs.push({ ...proof, ...mutation, result: 'owning-AssertionRED', receipt: observed.reference.file, sha256: observed.reference.sha256, served: sha(served),
          owningAssertion: observed.observed.failure.message.split('\n')[0], inputs: observed.inputs, inputsSha256: observed.inputsSha256 })
      }
    } finally { await writeFile(join(renderer, bundle.file), bundle.bytes); await writeFile(releasePath, releaseBytes) }
    const restored = await runRestart('join-restored')
    runs.push({ ...proof, id: 'restored', result: 'GREEN', served: proof.original, receipt: restored.reference.file, sha256: restored.reference.sha256, inputs: restored.inputs, inputsSha256: restored.inputsSha256 })
    receipt.joinMutations = { passed: true, runs }
    await writeFile(join(evidence, 'join-mutations.json'), JSON.stringify(receipt.joinMutations, null, 2) + '\n')

    receipt.passed = true
  }
} catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  // Keep a failed or build-only product for exact diagnosis; successful execution removes only its own tree.
  if (receipt.passed) { await rm(product, { recursive: true, force: true }); receipt.cleanup.productRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, buildOnly: args.includes('--build-only'), receipt: join(evidence, 'receipt.json'), failure: receipt.failure ?? null }) + '\n')
process.exitCode = failure ? 1 : 0
