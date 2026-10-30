import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { bundlePrivateNodeSource } from '../test/helpers/private-node-source-bundle.mjs'
import { workspaceSourceExport } from '../test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const development = process.argv.includes('--development'), mode = process.argv[2]?.slice(2)
assert.ok(['history-metadata', 'continuation'].includes(mode), 'Select the exact Context slice')
const directory = join(root, 'packages/core/.tmp/agent-context-' + mode)
await fs.mkdir(directory, { recursive: true })
const attempt = await fs.mkdtemp(join(directory, 'attempt-')), copy = join(attempt, 'source')
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = {}, bundles = [], runs = []
const receipt = { schema: 'agentmux.agent-context-slice-proof.v1', mode, development, passed: false, inputs, bundles, runs }
const copyFiles = ['packages/core/src', 'packages/core/package.json', 'packages/core/bin/amux',
  'packages/core/test/agent-context.test.ts', 'packages/core/test/fixtures/native-history-session.ts',
  'packages/core/test/helpers/fixture-values.ts', 'packages/core/test/helpers/object-cli-rpc.ts']
const monitored = ['packages/core/src/agent-session-store.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/agent-context.ts', 'packages/core/src/agentmux.ts']
const metadata = [
  'history metadata: claude active and retired original fields survive FileStore, Unix and compiled CLI',
  'history metadata: pi active and retired original fields survive FileStore, Unix and compiled CLI',
  ...['creation', 'forkedFrom', 'toolExecution'].map(field => 'history metadata: rejects malformed ' + field + ' and unknown metadata through the original decoder'),
  'binds cursor to exact Host, Session and native locator, and validates strict source payloads',
  'retains the original context source while exposing a different observed native identity'
]
const continuation = [
  'continuation: claude real Client BUSY preserves both source positions through Unix and compiled CLI',
  'continuation: pi real Client BUSY preserves both source positions through Unix and compiled CLI',
  'continuation: captured unavailability keeps its original window after native completion',
  'continuation: first-page unavailability stays unread until explicit continuation reaches actual completion',
  'binds cursor to exact Host, Session and native locator, and validates strict source payloads',
  'routes an exact configured remote Host through its original forwardRpc namespace'
]
const expected = mode === 'history-metadata' ? metadata : continuation
const pattern = mode === 'history-metadata' ? 'history metadata:|binds cursor to exact Host|retains the original context source'
  : 'continuation:|binds cursor to exact Host|routes an exact configured remote Host'
const owner = mode === 'history-metadata' ? 'packages/core/src/rpc-native-codec.ts' : 'packages/core/src/agent-context.ts'
const variants = mode === 'history-metadata' ? [
  { name: 'old-history-allowlist', pattern: 'history metadata: .* active and retired', names: metadata.slice(0, 2),
    from: '        if (descriptor.history !== undefined && !isDeepStrictEqual(',
    to: "        if (descriptor.history !== undefined) record(descriptor.history, ['providerId', 'executorId', 'workspacePath', 'createdAt', 'nativeHandle', 'observedNativeHandle', 'previousNativeHandle'])\n        if (descriptor.history !== undefined && !isDeepStrictEqual(" },
  { name: 'skip-history-normalization', pattern: 'history metadata: rejects malformed', names: metadata.slice(2, 5),
    from: '        if (descriptor.history !== undefined && !isDeepStrictEqual(', to: '        if (false && !isDeepStrictEqual(' }
] : [
  { name: 'presence-gated-completion', pattern: 'continuation:', names: continuation.slice(0, 4),
    from: '  const hasMore = !cursor.capturedDone || !cursor.nativeDone',
    to: '  const hasMore = timeline !== null && !cursor.capturedDone || native !== null && !cursor.nativeDone' },
  { name: 'reset-unavailable-native-position', pattern: 'continuation: .* real Client BUSY', names: continuation.slice(0, 2),
    from: '  if (native) {', to: '  if (!native && !cursor.nativeDone) cursor.nativeCursor = null\n  if (native) {' }
]
function original(path) { return path.startsWith(copy + '/') ? join(root, relative(copy, path)) : path }
async function bind(path) {
  path = original(resolve(path)); const name = relative(root, path), hash = sha(await fs.readFile(path))
  if (Object.hasOwn(inputs, name)) assert.equal(inputs[name], hash, 'Current source drift: ' + name)
  inputs[name] = hash
}
async function execute(args, env = {}) {
  return await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: copy, env: { ...process.env, ...env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
    child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, stdout, stderr }))
  })
}
try {
  for (const name of copyFiles) {
    const from = join(root, name), to = join(copy, name); await fs.mkdir(dirname(to), { recursive: true }); await fs.cp(from, to, { recursive: true })
    if ((await fs.stat(from)).isDirectory()) {
      for (const file of await fs.readdir(from, { recursive: true, withFileTypes: true })) if (file.isFile()) await bind(join(file.parentPath, file.name))
    } else await bind(from)
  }
  for (const name of ['node_modules', 'packages/core/node_modules', 'packages/core/vendor']) {
    await fs.mkdir(dirname(join(copy, name)), { recursive: true }); await fs.symlink(join(root, name), join(copy, name), 'dir')
  }
  await fs.writeFile(join(copy, 'package.json'), '{"type":"module"}\n')
  for (const path of ['packages/core/scripts/verify-agent-context.mjs', 'packages/core/scripts/verify-agent-context-slices.mjs',
    'packages/core/test/helpers/private-node-source-bundle.mjs', 'packages/core/test/helpers/workspace-source-export.mjs',
    'packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts', 'packages/identity/src/index.ts', 'tsconfig.base.json', 'pnpm-lock.yaml']) await bind(join(root, path))
  const identity = join(copy, 'identity-runtime-source.mjs')
  await fs.writeFile(identity, 'export const identityRuntimeSource = ' + JSON.stringify((await bundleIdentityRuntime()).source) + ';\n')
  receipt.identityRuntimeSHA256 = sha(await fs.readFile(identity))
  const sourceExport = name => name === '@agentmux/identity/runtime-source' ? identity : workspaceSourceExport(name.startsWith('@agentmux/core') ? copy : root, name)
  const evaluatedCli = join(attempt, 'cli-evaluated.jsonl')
  for (const entry of ['control-endpoint-listener-worker', 'agentmux']) {
    const built = await bundlePrivateNodeSource({ root: copy, entry: `packages/core/src/${entry}.ts`, file: `packages/core/dist/${entry}.js`, sourceExport,
      instrument(source, name) {
        if (!monitored.includes(name)) return source
        return `import { appendFileSync as __contextEvaluated } from 'node:fs'; __contextEvaluated(${JSON.stringify(evaluatedCli)}, ${JSON.stringify(JSON.stringify({ path: name, sourceSHA256: sha(source) }) + '\n')});\n` + source.replace(/^#![^\n]*\n/u, '')
      } })
    bundles.push(built.record)
    for (const item of built.record.sources) {
      const path = resolve(copy, item.path)
      if (path === identity) continue
      await bind(path)
    }
  }
  const aliases = []
  for (const name of await fs.readdir(join(root, 'packages'))) {
    const manifest = join(root, 'packages', name, 'package.json'); let pkg
    try { pkg = JSON.parse(await fs.readFile(manifest, 'utf8')) } catch { continue }
    await bind(manifest)
    for (const key of Object.keys(pkg.exports ?? {})) {
      const id = key === '.' ? pkg.name : pkg.name + key.slice(1)
      if (key.includes('*')) continue
      try { const path = sourceExport(id); if (path) aliases.push([id, path]) } catch { /* unused exports without source are not type paths */ }
    }
  }
  aliases.push(['@agentmux/identity/runtime-source', identity])
  if (!development) {
    // Relay owns a separate tsconfig. Emit its current declarations under that
    // contract, then let Core check their consumption with all Core flags intact.
    const dependencyTypes = join(copy, 'dependency-types'), declarations = new Map()
    receipt.dependencyTypechecks = []
    for (const name of ['identity', 'relay']) {
      const originalConfig = join(root, 'packages', name, 'tsconfig.json'), output = join(dependencyTypes, name)
      await bind(originalConfig)
      const configPath = join(attempt, name + '-typecheck.json')
      await fs.writeFile(configPath, JSON.stringify({ extends: originalConfig, compilerOptions: {
        declaration: true, emitDeclarationOnly: true, noEmit: false, outDir: output,
        ...(name === 'relay' ? { baseUrl: root, paths: { '@agentmux/identity': [join(dependencyTypes, 'identity/index.d.ts')] } } : {})
      } }, null, 2) + '\n')
      const command = [require.resolve('typescript/bin/tsc'), '--pretty', 'false', '--listFiles', '-p', configPath]
      const result = await execute(command), log = result.stdout + result.stderr
      await fs.writeFile(join(attempt, name + '-typecheck.log'), log)
      const proof = { package: name, command: [process.execPath, ...command], exitCode: result.code, signal: result.signal,
        configSHA256: sha(await fs.readFile(configPath)), outputSHA256: sha(log), declarations: [] }
      receipt.dependencyTypechecks.push(proof)
      assert.equal(result.code, 0, 'Current dependency declarations failed: ' + name)
      for (const path of result.stdout.trim().split('\n')) if (path.startsWith(root + '/') && !path.includes('/node_modules/') && !declarations.has(path)) await bind(path)
      for (const file of await fs.readdir(output, { recursive: true, withFileTypes: true })) if (file.isFile()) {
        const path = join(file.parentPath, file.name), hash = sha(await fs.readFile(path))
        declarations.set(path, hash); proof.declarations.push({ path: relative(copy, path), sha256: hash })
      }
      assert.ok(proof.declarations.length > 0, 'Declaration emit must be nonempty')
      proof.dependencyRoot = join(root, 'packages', name, 'node_modules')
      await fs.symlink(proof.dependencyRoot, join(output, 'node_modules'), 'dir')
    }
    const coreAliases = aliases.map(([name, path]) => [name, [name === '@agentmux/relay' || name.startsWith('@agentmux/relay/')
      ? join(dependencyTypes, 'relay', relative(join(root, 'packages/relay/src'), path).replace(/\.ts$/u, '.d.ts')) : path]])
    const config = { extends: join(root, 'tsconfig.base.json'), compilerOptions: { rootDir: root, noEmit: true, allowJs: true, checkJs: false,
      module: 'ESNext', moduleResolution: 'Bundler', types: ['node'], typeRoots: [join(root, 'packages/core/node_modules/@types')], baseUrl: copy,
      paths: Object.fromEntries(coreAliases) },
      files: [join(copy, 'packages/core/test/agent-context.test.ts'), join(copy, 'packages/core/src/agentmux.ts')] }
    const configPath = join(attempt, 'typecheck.json'); await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
    const ts = require('typescript'), parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath))
    assert.equal(parsed.errors.length, 0, 'Core typecheck configuration must parse')
    const declarationImports = []
    for (const path of declarations.keys()) for (const { fileName } of ts.preProcessFile(await fs.readFile(path, 'utf8'), true, true).importedFiles) {
      if (fileName.startsWith('.') || isBuiltin(fileName)) continue
      const resolved = ts.resolveModuleName(fileName, path, parsed.options, ts.sys).resolvedModule
      assert.ok(resolved && ['.ts', '.tsx', '.d.ts', '.d.mts', '.d.cts'].includes(resolved.extension), 'Declaration type import must resolve: ' + fileName)
      declarationImports.push({ declaration: relative(copy, path), specifier: fileName, resolved: resolved.resolvedFileName,
        sha256: sha(await fs.readFile(resolved.resolvedFileName)) })
    }
    const command = [require.resolve('typescript/bin/tsc'), '--pretty', 'false', '--listFiles', '-p', configPath]
    const result = await execute(command)
    await fs.writeFile(join(attempt, 'typecheck.log'), result.stdout + result.stderr)
    receipt.typecheck = { command: [process.execPath, ...command], config: relative(root, configPath), configSHA256: sha(await fs.readFile(configPath)),
      exitCode: result.code, signal: result.signal, outputSHA256: sha(result.stdout + result.stderr), declarationImports, consumedDeclarations: [] }
    assert.equal(result.code, 0, 'Actual owner TypeScript graph failed: ' + join(attempt, 'typecheck.log'))
    const typedFiles = result.stdout.trim().split('\n')
    assert.ok(!typedFiles.some(path => path.startsWith(join(root, 'packages/relay/src') + '/')), 'Core consumes emitted Relay declarations, not foreign source under Core flags')
    for (const item of declarationImports) {
      item.consumedByCore = typedFiles.includes(join(copy, item.declaration))
      if (item.consumedByCore) assert.ok(typedFiles.includes(item.resolved), 'Consumed declaration dependency must enter the actual Core graph: ' + item.specifier)
      assert.equal(sha(await fs.readFile(item.resolved)), item.sha256)
    }
    for (const path of typedFiles) if (path.startsWith(root + '/') && !path.includes('/node_modules/')) {
      if (path === identity) {
        assert.equal(sha(await fs.readFile(path)), receipt.identityRuntimeSHA256)
        receipt.typecheck.generatedRuntimeSourceConsumed = true
      } else if (declarations.has(path)) {
        assert.equal(sha(await fs.readFile(path)), declarations.get(path))
        receipt.typecheck.consumedDeclarations.push({ path: relative(copy, path), sha256: declarations.get(path) })
      } else await bind(path)
    }
    assert.ok(receipt.typecheck.consumedDeclarations.some(value => value.path.startsWith('dependency-types/relay/')))
  }
  const test = async (name, pattern, names, red = false) => {
    const report = join(attempt, name + '.json'), loaded = join(attempt, name + '-evaluated.jsonl'), facts = join(attempt, name + '-cleanup.jsonl')
    const config = join(attempt, name + '.config.mts')
    await fs.writeFile(config, `import {appendFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {workspaceSourceExport} from ${JSON.stringify(join(root, 'packages/core/test/helpers/workspace-source-export.mjs'))};
export default {root:${JSON.stringify(copy)},plugins:[{name:'context-current-source',enforce:'pre',resolveId(id){if(id==='@agentmux/identity/runtime-source')return ${JSON.stringify(identity)};if(id.startsWith('@agentmux/'))return workspaceSourceExport(id.startsWith('@agentmux/core')?${JSON.stringify(copy)}:${JSON.stringify(root)},id)},transform(code,id){if(${JSON.stringify(monitored.map(path => join(copy, path)))}.includes(id)){const record={path:id.slice(${JSON.stringify(copy.length + 1)}),sourceSHA256:createHash('sha256').update(readFileSync(id)).digest('hex')};return "import {appendFileSync as __contextEvaluated} from 'node:fs';__contextEvaluated("+${JSON.stringify(JSON.stringify(loaded))}+","+JSON.stringify(JSON.stringify(record)+'\\n')+");\\n"+code}}}],test:{include:['packages/core/test/agent-context.test.ts'],testNamePattern:${JSON.stringify(pattern)},maxWorkers:1,passWithNoTests:false,testTimeout:20000,hookTimeout:20000}}\n`)
    const result = await execute([require.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report], {
      AGENTMUX_TEST_OBJECT_CLI: join(copy, 'packages/core/bin/amux'), AGENTMUX_CONTEXT_FACTS: facts })
    await fs.writeFile(join(attempt, name + '.log'), result.stdout + result.stderr)
    const data = JSON.parse(await fs.readFile(report, 'utf8')), assertions = data.testResults.flatMap(suite => suite.assertionResults).filter(item => ['passed', 'failed'].includes(item.status))
    const evaluations = (await fs.readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const cleanup = (await fs.readFile(facts, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    runs.push({ name, expected: names, exitCode: result.code, signal: result.signal, assertions, evaluations, cleanup, reportSHA256: sha(await fs.readFile(report)), logSHA256: sha(result.stdout + result.stderr) })
    assert.deepEqual(assertions.map(item => item.fullName.trim()).sort(), [...names].sort(), 'Exact nonempty selected test set')
    assert.equal(cleanup.length, names.length); assert.ok(cleanup.every(value => value.cleanupErrors.length === 0 && value.removedRoots.length > 0))
    const effectiveOwner = sha(await fs.readFile(join(copy, owner)))
    assert.ok(evaluations.some(value => value.path === owner && value.sourceSHA256 === effectiveOwner), 'Actual selected Context owner source must execute')
    if (red) assert.notEqual(effectiveOwner, inputs[owner])
    assert.equal(result.signal, null); assert.equal(result.code, red ? 1 : 0, 'Unexpected test result: ' + name)
    if (red) assert.ok(assertions.some(item => item.status === 'failed' && item.failureMessages.some(text => text.includes('AssertionError'))), 'Only actual assertion RED qualifies')
    else assert.ok(assertions.every(item => item.status === 'passed'))
    console.log(name + ': ' + (red ? 'assertion RED' : names.length + ' GREEN'))
  }
  await test('baseline', pattern, expected)
  if (!development) {
    const path = join(copy, owner), baseline = await fs.readFile(path, 'utf8')
    for (const variant of variants) {
      assert.equal(baseline.split(variant.from).length, 2, 'Unique current source mutation anchor')
      await fs.writeFile(path, baseline.replace(variant.from, variant.to))
      try { await test(variant.name, variant.pattern, variant.names, true) }
      finally { await fs.writeFile(path, baseline) }
      await test(variant.name + '-restored', variant.pattern, variant.names)
    }
    const evaluated = (await fs.readFile(evaluatedCli, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(evaluated.some(value => value.path === 'packages/core/src/agentmux.ts'))
    assert.ok(evaluated.some(value => value.path === 'packages/core/src/rpc-native-codec.ts'))
    receipt.cliEvaluated = evaluated
  }
  for (const [path, hash] of Object.entries(inputs)) assert.equal(sha(await fs.readFile(join(root, path))), hash, 'Shared source drift: ' + path)
  receipt.sourceStable = true; receipt.passed = !development; receipt.developmentPassed = development
} catch (error) { receipt.error = error.stack; process.exitCode = 1 }
finally {
  await fs.rm(copy, { recursive: true, force: true })
  receipt.cleanup = { privateSourceRemoved: await fs.stat(copy).then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true }), sharedSourceMutations: 0 }
  await fs.writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log('Receipt: ' + join(attempt, 'receipt.json'))
  if (receipt.error) console.error(receipt.error)
}
