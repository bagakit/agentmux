import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile), repository = resolve(import.meta.dirname, '../../..')
const here = fileURLToPath(import.meta.url), fixture = join(import.meta.dirname, 'fixtures/runtime-native-dependency-closure')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:AGENTMUX_|CTXMUX_)/u.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)))
async function put(path, contents) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents) }
async function json(path, value) { await put(path, JSON.stringify(value, null, 2) + '\n') }
async function consume(kind, root, work) {
  let result
  try { result = await exec(process.execPath, [join(fixture, 'consumer.mjs'), kind, root, work], {
    cwd: work, env: cleanEnvironment(), maxBuffer: 2 * 1024 * 1024, timeout: 30_000 }) }
  catch (error) { assert.fail(`The isolated ${kind} consumer must execute the copied runtime: ${error.stderr ?? error.message}`) }
  return JSON.parse(result.stdout)
}
async function packageFixture(root, name, manifest = {}, value = '') {
  await json(join(root, 'package.json'), { name, version: '1.0.0', main: 'index.cjs', ...manifest })
  await put(join(root, 'index.cjs'), value || 'module.exports = {}\n')
}
async function graphFixture(root, cycle = false) {
  const core = join(root, 'packages/core'), modules = join(root, 'node_modules')
  for (const name of ['capsule', 'demand', 'diagnostic-evidence', 'git', 'identity', 'relay']) {
    const workspace = join(root, 'packages', name)
    await packageFixture(workspace, '@agentmux/' + name, { files: ['index.cjs'] })
    await put(join(workspace, 'private-source.txt'), 'must not ship')
  }
  await packageFixture(core, '@agentmux/core', { type: 'commonjs', main: 'dist/index.cjs',
    dependencies: { ordinary: '*', first: 'npm:plugin@1', second: 'npm:plugin@1', '@agentmux/capsule': 'workspace:*' },
    optionalDependencies: { 'present-optional': '*', 'absent-optional': '*', 'foreign-installed-optional': '*' },
    peerDependencies: { 'root-peer': '*', 'absent-peer': '*' }, peerDependenciesMeta: { 'absent-peer': { optional: true } } })
  await put(join(core, 'dist/index.cjs'), `module.exports={ordinary:require('ordinary').value,optional:require('present-optional').value,rootPeer:require('root-peer').value,first:require('first'),second:require('second')}\n`)
  for (const entry of ['vendor', 'bin']) await mkdir(join(core, entry), { recursive: true })
  await json(join(core, 'src/ctxmux-artifact-contract.json'), {})
  for (const [name, value] of [['ordinary', 7], ['present-optional', 11], ['root-peer', 17], ['peer', 99]]) {
    await packageFixture(join(modules, name), name, { files: ['index.cjs'] }, `module.exports={value:${value}}\n`)
  }
  await put(join(modules, 'ordinary/installed-runtime.txt'), 'installed files remain runtime files')
  await packageFixture(join(modules, 'foreign-installed-optional'), 'foreign-installed-optional', {
    os: [process.platform === 'darwin' ? 'linux' : 'darwin'], cpu: ['x64'] })
  await mkdir(join(modules, '@agentmux'), { recursive: true })
  for (const name of ['capsule', 'demand', 'diagnostic-evidence', 'git', 'identity', 'relay']) {
    await symlink(join(root, 'packages', name), join(modules, '@agentmux', name))
  }
  for (const [alias, value] of [['first', 1], ['second', 2]]) {
    const context = join(modules, '.pnpm', alias, 'node_modules'), plugin = join(context, 'plugin')
    await packageFixture(plugin, 'plugin', { dependencies: { ordinary: '*' }, peerDependencies: { peer: '*', 'root-peer': '*' } },
      `module.exports={ordinary:require('ordinary').value,peer:require('peer').value,rootPeer:require('root-peer')}\n`)
    await packageFixture(join(context, 'peer'), 'peer', {}, `module.exports={value:${value}}\n`)
    await symlink(plugin, join(modules, alias))
  }
  if (cycle) {
    await packageFixture(join(modules, 'cycle-a'), 'cycle-a', { dependencies: { 'cycle-b': '*' } },
      "exports.marker='a';exports.b=require('cycle-b')\n")
    await packageFixture(join(modules, 'cycle-b'), 'cycle-b', { peerDependencies: { 'cycle-a': '*' } },
      "module.exports={marker:'b',a:require('cycle-a').marker}\n")
    const manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
    const entry = cycle === 'alias' ? 'cycle-entry' : 'cycle-a'
    manifest.dependencies[entry] = '*'; await json(join(core, 'package.json'), manifest)
    if (cycle === 'alias') await symlink(join(modules, 'cycle-a'), join(modules, entry))
    await put(join(core, 'dist/index.cjs'), (await readFile(join(core, 'dist/index.cjs'), 'utf8')) + `module.exports.cycle=require('${entry}')\n`)
  }
  return core
}
async function materializeAppCore(source, temporary) {
  const { inspectRuntimeApplicationPayload, copyRuntimeFiles } = await import(pathToFileURL(join(repository, 'apps/desktop/scripts/runtime-application-payload.mjs')).href)
  const payload = await inspectRuntimeApplicationPayload(source), prefix = 'node_modules/@agentmux/core'
  const resources = join(temporary, 'app'), selected = payload.copies.filter(value => value.target.startsWith(prefix + '/'))
  assert.ok(selected.length > 10, 'The real App Core payload must select actual dependency files')
  await copyRuntimeFiles(selected, resources)
  for (const item of payload.generated.filter(value => value.target === prefix + '/package.json')) await put(join(resources, item.target), item.contents)
  for (const item of payload.links.filter(value => value.target.startsWith(prefix + '/node_modules/'))) {
    const target = join(resources, item.target); await mkdir(dirname(target), { recursive: true }); await symlink(item.link, target)
  }
  return join(resources, prefix)
}
async function appFixture(root) {
  await json(join(root, 'apps/desktop/package.json'), { name: 'private-app-fixture', version: '1.0.0' })
  for (const owner of ['apps/desktop', 'apps/host', 'packages/connectors']) {
    const target = join(root, owner, 'node_modules'); await mkdir(dirname(target), { recursive: true })
    await symlink(join(repository, owner, 'node_modules'), target)
  }
}
async function runCase(kind, temporary) {
  const { inspectPackageClosure, materializeRuntimeCore } = await import(pathToFileURL(join(repository, 'scripts/package-dependencies.mjs')).href)
  if (kind === 'app-portable-core') {
    const core = await materializeAppCore(repository, temporary)
    const { createPortableCoreArtifact } = await import(pathToFileURL(join(repository, 'packages/core/dist/portable-core-artifact.js')).href)
    const artifact = await createPortableCoreArtifact(join(temporary, 'artifact'), core)
    assert.ok(artifact.files.length > 100, 'The actual portable artifact must collect a nonempty assembled Core')
    const consumed = await consume('artifact-host-js', join(temporary, 'artifact/core'), join(temporary, 'work'))
    return { case: kind, passed: true, artifact: { digest: artifact.digest, files: artifact.files.length,
      nativeTarget: 'linux-x64', nativeTargetExecuted: false, hostJsOnly: true }, consumed }
  }
  if (kind === 'app-react') {
    const { inspectRuntimeApplicationPayload, copyRuntimeFiles } = await import(pathToFileURL(join(repository, 'apps/desktop/scripts/runtime-application-payload.mjs')).href)
    const payload = await inspectRuntimeApplicationPayload(repository), target = join(temporary, 'react-app')
    await copyRuntimeFiles(payload.copies.filter(value => ['node_modules/react/', 'node_modules/react-dom/', 'node_modules/scheduler/'].some(prefix => value.target.startsWith(prefix))), target)
    await json(join(target, 'package.json'), { private: true })
    return { case: kind, passed: true, consumed: await consume('react', target, join(temporary, 'work')) }
  }
  if (kind === 'graph' || kind === 'same-peer' || kind.startsWith('cycle-')) {
    const source = join(temporary, 'source'), core = await graphFixture(source, kind.includes('alias') ? 'alias' : kind.startsWith('cycle-'))
    process.env.AGENTMUX_CLOSURE_PUBLICATION_ROOT = source
    const closure = await inspectPackageClosure(core)
    assert.ok(closure.packages.length > 5, 'A nonempty installed closure must be inspected')
    if (kind.includes('alias')) {
      // Node can consume the installed graph. Only this candidate build is rejected
      // because its regular-file portable artifact cannot preserve the alias cycle.
      assert.equal(createRequire(join(core, 'package.json'))(core).cycle.b.a, 'a')
      await assert.rejects(kind.endsWith('-app') ? (async () => {
        await appFixture(source); return await materializeAppCore(source, temporary)
      })() : materializeRuntimeCore(source, join(temporary, 'runtime'), { sourceCommit: null }), error =>
        error.code === 'PACKAGE_RUNTIME_GRAPH_UNSUPPORTED' && error.dependency === 'cycle-a')
      return { case: kind, passed: true, installedGraphConsumable: true,
        candidateRejected: 'PACKAGE_RUNTIME_GRAPH_UNSUPPORTED', existingAppOrRunTouched: false }
    }
    let destination
    if (kind.endsWith('-app')) {
      await appFixture(source)
      destination = await materializeAppCore(source, temporary)
    } else destination = await materializeRuntimeCore(source, join(temporary, 'runtime'), { sourceCommit: null })
    const result = await consume(kind === 'graph' || kind === 'same-peer' ? kind : kind.includes('alias') ? 'cycle-alias' : 'cycle', destination, temporary)
    assert.equal(closure.packages[closure.root].dependencies.find(value => value.name === 'absent-optional').packageId, null)
    assert.equal(closure.packages[closure.root].dependencies.find(value => value.name === 'absent-peer').packageId, null)
    const manifestPath = join(core, 'package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.peerDependencies['missing-required-peer'] = '*'; await json(manifestPath, manifest)
    await assert.rejects(inspectPackageClosure(core), { code: 'PACKAGE_DEPENDENCY_UNAVAILABLE' })
    return { case: kind, passed: true, consumed: result, missingRequiredPeerRejected: true,
      missingOptionalAndOptionalPeerAllowed: true, workspacePublicationAndInstalledFilesPreserved: true,
      installedForeignOptionalPreservedWithoutQualification: true }
  }
  let destination
  if (kind === 'app-native') destination = await materializeAppCore(repository, temporary)
  else destination = await materializeRuntimeCore(repository, join(temporary, 'runtime-core'), { sourceCommit: null })
  const consumed = await consume(kind, destination, join(temporary, 'work'))
  for (const [name, hash] of Object.entries(consumed.coreModules)) {
    assert.equal(hash, sha(await readFile(join(repository, 'packages/core/dist', name + '.js'))), 'The isolated consumer must use the original compiled Core module')
  }
  return { case: kind, passed: true, consumed }
}

if (process.argv[2] === '--case') {
  const [, , , kind, temporary] = process.argv
  await mkdir(join(temporary, 'work'), { recursive: true })
  let result
  try { result = await runCase(kind, temporary) }
  catch (error) { assert.fail(`The ${kind} runtime consumer must be materializable: ${error.stack}`) }
  process.stdout.write(JSON.stringify(result) + '\n')
} else {
  assert.equal(process.platform, 'darwin', 'This App payload gate requires its actual macOS copy/native consumer; Linux target qualification is separate')
  const evidence = join(repository, '.local/state/runtime-native-dependency-closure')
  await mkdir(evidence, { recursive: true })
  const sources = ['scripts/package-dependencies.mjs', 'apps/desktop/scripts/runtime-application-payload.mjs',
    'apps/desktop/scripts/verify-runtime-native-dependency-closure.mjs', ...['consumer', 'loader'].map(name =>
      'apps/desktop/scripts/fixtures/runtime-native-dependency-closure/' + name + '.mjs'),
    ...['native-file-clone', 'directory-write', 'errors', 'portable-core-artifact'].flatMap(name => ['packages/core/src/' + name + '.ts', 'packages/core/dist/' + name + '.js']),
    'packages/core/package.json', 'pnpm-workspace.yaml']
  const bindings = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, sha(await readFile(join(repository, path)))])))
  const receipt = { schema: 'agentmux.runtime-native-dependency-closure-proof.v1', passed: false, inputs: await bindings(),
    platform: process.platform, arch: process.arch, cases: [], mutations: [], userRuntimeTouched: false,
    targetBoundary: 'This gate consumes the current host installed graph. All installed optional packages are preserved without os/cpu filtering; absent optional packages remain absent. It neither prepares nor qualifies another target graph, especially Linux from a Darwin installation.' }
  const runs = [
    ['app-native', null], ['portable-native', null], ['app-portable-core', null], ['graph', null], ['app-react', null], ['cycle-app', null], ['cycle-portable', null],
    ['cycle-alias-app', null], ['cycle-alias-portable', null],
    ['app-native', 'omit-optionals'], ['graph', 'omit-peers'], ['graph', 'flatten-peer-context'],
    ['graph', 'omit-required'], ['portable-native', 'portable-skips-dependencies'], ['cycle-portable', 'no-back-edge'],
    ['cycle-alias-portable', 'allow-unrepresentable-peer'], ['graph', 'unplanned-slots'], ['app-react', 'isolated-roots'],
    ['app-portable-core', 'merge-distribution-scopes']
  ]
  try {
    for (const [kind, mutation] of runs) {
      const name = mutation ?? kind, log = join(evidence, name + '.loaded.jsonl')
      await writeFile(log, '')
      const temporary = await realpath(await mkdtemp(join(tmpdir(), 'amux-runtime-native-closure-')))
      let code = 0, stdout = '', stderr = ''
      try {
        try { ({ stdout, stderr } = await exec(process.execPath, ['--loader', pathToFileURL(join(fixture, 'loader.mjs')).href,
          here, '--case', kind, temporary], { cwd: temporary, env: { ...cleanEnvironment(),
            AGENTMUX_CLOSURE_REPOSITORY: repository, AGENTMUX_CLOSURE_LOADED: log,
            ...(mutation ? { AGENTMUX_CLOSURE_MUTATION: mutation } : {}) }, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 })) }
        catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
        await writeFile(join(evidence, name + '.log'), stdout + stderr)
        const loaded = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const evaluated = loaded.filter(value => value.stage === 'evaluated')
        assert.ok(evaluated.some(value => value.path === 'scripts/package-dependencies.mjs'), 'The original dependency owner must actually evaluate')
        if (kind.endsWith('-app') || kind.startsWith('app-')) assert.ok(evaluated.some(value => value.path === 'apps/desktop/scripts/runtime-application-payload.mjs'), 'The actual App selector must evaluate')
        for (const value of evaluated) {
          assert.equal(value.originalSHA256, receipt.inputs[value.path], 'The gate must consume the frozen source')
          assert.ok(loaded.some(entry => entry.stage === 'returned' && entry.path === value.path && entry.transformedSHA256 === value.transformedSHA256))
        }
        if (mutation) {
          assert.equal(code, 1, 'The loaded mutation must be rejected')
          assert.match(stderr, /AssertionError/u, 'A real consumer assertion must fail, rather than a loader/import setup error')
          if (mutation === 'no-back-edge') assert.match(stderr, /peer back-edge/u, 'Removing accurate back-edge reuse must reject the valid original cycle')
          assert.ok(evaluated.some(value => value.originalSHA256 !== value.transformedSHA256), 'The mutation must change actually evaluated production code')
          receipt.mutations.push({ name, case: kind, exitCode: code, assertionRed: true, loaded })
        } else {
          assert.equal(code, 0, stderr)
          const consumed = JSON.parse(stdout.trim())
          assert.equal(consumed.passed, true)
          receipt.cases.push({ ...consumed, loaded })
        }
      } finally {
        try { await rm(temporary, { recursive: true, force: true }) }
        catch (error) { receipt.cleanedPrivateRoots = false; receipt.retainedPrivateRoot = temporary; throw error }
      }
    }
    assert.equal(receipt.cases.length, 9); assert.equal(receipt.mutations.length, 10)
    assert.deepEqual(await bindings(), receipt.inputs, 'Reviewed source and compiled Core leaves must not change during the gate')
    receipt.passed = true
  } finally {
    receipt.cleanedPrivateRoots ??= true
    await json(join(evidence, 'receipt.json'), receipt)
  }
  process.stdout.write(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.length, mutations: receipt.mutations.length,
    receipt: join(evidence, 'receipt.json'), targetBoundary: receipt.targetBoundary }) + '\n')
}
