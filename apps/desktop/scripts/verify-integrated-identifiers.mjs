import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire, findPackageJSON, isBuiltin } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mintObjectId } from '@agentmux/core/object-id'
import { integratedIdentityMutations } from './lib/integrated-identifier-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const output = join(root, '.tmp/integrated-identifiers', mintObjectId())
await mkdir(output, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.integrated-identifiers-proof.v1', status: 'running', inventory: [], consumers: [], mutants: [], restart: null, types: null }
const restartModule = join(output, 'mote-chat-restart.mjs')
async function command(name, args, env = {}) {
  let log = ''
  const code = await new Promise((accept, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
    child.once('error', reject); child.once('exit', accept)
  })
  await writeFile(join(output, name + '.log'), log)
  return { code, log }
}
async function consumer(name, mutation) {
  const report = join(output, name + '.json'), loaded = join(output, name + '.loaded.ndjson')
  const result = await command(name, ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/integrated-identifiers.config.mts',
    '--reporter=json', '--outputFile=' + report], { AMUX_INTEGRATED_ID_LOADED: loaded, AMUX_INTEGRATED_ID_MUTATION: mutation ?? '',
    AGENTMUX_MOTE_CHAT_RESTART_MODULE: pathToFileURL(restartModule).href })
  const tests = JSON.parse(await readFile(report, 'utf8'))
  const sources = (await readFile(loaded, 'utf8')).trim().split('\n').map(JSON.parse)
  const active = tests.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(active.length > 0 && tests.numPendingTests === 0 && tests.numTodoTests === 0, 'An empty or inactive consumer set cannot pass')
  assert.equal(tests.numRuntimeErrorTestSuites ?? 0, 0, 'Loader errors do not prove identifier behavior')
  if (mutation) {
    const file = integratedIdentityMutations[mutation].file
    const changed = sources.find(source => source.path === file && source.mutation === mutation && source.sourceSHA256 !== source.loadedSHA256)
    assert.ok(changed, 'The actual allocator consumer must load the mutation: ' + mutation)
    assert.notEqual(result.code, 0, 'Mutation survived: ' + mutation)
    assert.ok(active.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'A mutation must fail an assertion')
    receipt.mutants.push({ mutation, source: changed, active: active.length, failed: tests.numFailedTests })
  } else {
    assert.equal(result.code, 0, result.log.slice(-4000))
    assert.ok(active.every(test => test.status === 'passed'), 'All selected consumers must execute and pass')
    for (const file of receipt.inventory) assert.ok(sources.some(source => source.path === file.path && source.sourceSHA256 === file.sha256), 'Current owner source must reach its real consumer: ' + file.path)
    receipt.consumers.push({ name, active: active.length, loadedSHA256: sha(JSON.stringify(sources)) })
  }
}
try {
  const paths = [...new Set(Object.values(integratedIdentityMutations).map(value => value.file))]
  assert.equal(paths.length, 9, 'The integration slice must cover eight new owners and their capture parser')
  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8')
    assert.doesNotMatch(source, /\brandomUUID\s*\(/u, 'An ordinary allocator bypass remains: ' + path)
    if (path !== 'packages/core/src/renderer-heap-snapshot.ts') assert.match(source, /import \{ mintObjectId \} from '@agentmux\/core\/object-id'/u)
    receipt.inventory.push({ path, sha256: sha(source) })
  }
  // A tiny private artifact supplies the existing cross-process durability test.
  // Source aliases exercise current owners without rebuilding shared package dist.
  const vitestRequire = createRequire(import.meta.resolve('vitest/config'))
  const { build } = createRequire(vitestRequire.resolve('vite/package.json'))('esbuild')
  const entry = join(output, 'mote-chat-restart.ts')
  await writeFile(entry, `export { ConnectionHost } from ${JSON.stringify(join(root, 'packages/connectors/src/connection-host.ts'))};\nexport { MoteChatHost } from ${JSON.stringify(join(root, 'packages/connectors/src/mote-chat.ts'))};\n`)
  const aliases = {}, typePaths = {}
  for (const pkg of ['core', 'identity', 'connectors', 'demand', 'diagnostic-evidence', 'client-ui']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      const target = typeof value === 'string' ? value : value.types ?? value.import
      if (!target) continue
      const source = join('packages', pkg, target.replace(/^\.\/dist\/(?:src\/)?/u, 'src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
      const name = '@agentmux/' + pkg + (key === '.' ? '' : key.slice(1))
      if (existsSync(join(root, source)) || source.includes('*')) typePaths[name] = [source]
      if (!source.includes('*') && existsSync(join(root, source))) aliases[name] = join(root, source)
    }
  }
  const built = await build({ entryPoints: [entry], outfile: restartModule, bundle: true, platform: 'node', target: 'node24', format: 'esm',
    packages: 'external', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'current-restart-owners', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        if (aliases[args.path]) return { path: aliases[args.path] }
        let dependency
        try {
          const manifestPath = findPackageJSON(args.path, pathToFileURL(args.importer).href)
          if (!manifestPath) throw new Error('Dependency manifest is unavailable')
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          const packageName = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0]
          const key = args.path === packageName ? '.' : '.' + args.path.slice(packageName.length)
          let target = Object.hasOwn(manifest.exports, key) ? manifest.exports[key] : key === '.' ? manifest.exports : undefined
          while (target && typeof target === 'object') target = target.import ?? target.node ?? target.default
          if (typeof target !== 'string') throw new Error('No explicit ESM dependency export')
          dependency = resolve(dirname(manifestPath), target)
        } catch { dependency = createRequire(args.importer).resolve(args.path) }
        return { path: pathToFileURL(dependency).href, external: true }
      })
    } }] })
  const restartSources = []
  for (const path of Object.keys(built.metafile.inputs).filter(path => !path.includes('node_modules/'))) {
    const file = resolve(root, path)
    restartSources.push({ path: relative(root, file), sha256: sha(await readFile(file)) })
  }
  receipt.restart = { sha256: sha(await readFile(restartModule)), sources: restartSources }
  await consumer('baseline')
  for (const mutation of Object.keys(integratedIdentityMutations)) await consumer('mutation-' + mutation, mutation)
  await consumer('restored')
  const typeConfig = join(output, 'types.json')
  await writeFile(typeConfig, JSON.stringify({ extends: join(root, 'apps/desktop/test/tsconfig.integrated-identifiers.json'),
    compilerOptions: { baseUrl: root, paths: typePaths, types: [join(root, 'node_modules/@types/node'),
      join(root, 'apps/desktop/node_modules/vite/client'), join(root, 'node_modules/vitest/globals')] } }, null, 2) + '\n')
  const types = await command('types', ['exec', 'tsc', '--noEmit', '--pretty', 'false', '-p', typeConfig])
  assert.equal(types.code, 0, types.log.slice(-4000))
  receipt.types = { command: 'tsc --noEmit -p ' + relative(root, typeConfig), configSHA256: sha(await readFile(typeConfig)), passed: true }
  for (const file of receipt.inventory) assert.equal(sha(await readFile(join(root, file.path))), file.sha256, 'An owner changed during this proof; rerun the bounded gate')
  receipt.status = 'passed'
} catch (error) { receipt.status = 'failed'; receipt.error = String(error?.stack ?? error); throw error }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); process.stdout.write(relative(root, join(output, 'receipt.json')) + '\n') }
