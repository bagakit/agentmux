import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { isBuiltin } from 'node:module'

const root = resolve(import.meta.dirname, '../../..')
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFile(resolve(root, path), 'utf8')
const owned = ['packages/core/src/client.ts', 'packages/core/test/hook-postcommit-observation.test.ts',
  'packages/core/test/hook-postcommit-observation.vitest.config.mts', 'packages/core/scripts/verify-hook-postcommit-observation.mjs',
  'docs/design/behavior/session-recovery.md']
const inputs = new Map()
async function bind(path) {
  const absolute = resolve(root, path), hash = sha(await readFile(absolute))
  if (inputs.has(absolute) && inputs.get(absolute) !== hash) throw new Error('Source changed during verification: ' + absolute)
  inputs.set(absolute, hash)
}
for (const path of owned) await bind(path)
const output = join(root, 'packages/core/.tmp/hook-postcommit-observation')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
const receipt = { schema: 'agentmux.hook-postcommit-observation.v1', root, attempt, sourceStable: false,
  qualified: false, candidate: null, mutants: [], callers: [], inputs: {}, scope: {
    userRuntimeTouched: false, actual: 'Core Hook HTTP sender, real SQLite FileStore and public RPC/compiled CLI; Desktop production projection and notice render',
    controlled: 'auxiliary setup/pending, provider lookup rejection and actual SQLite post-COMMIT file-sync failure',
    originalIncidentPhase: 'unknown', noticeAutomaticClearing: false, installationQualified: false } }
await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
try {
const alias = {}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  await bind(manifest)
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : value.import
    if (!entry?.startsWith('./dist/')) continue
    const source = resolve(dirname(manifest), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    try { await stat(source); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
  }
}
const client = await read('packages/core/src/client.ts')
const detachStart = client.indexOf('    // This receipt\'s required durable work')
const detachEnd = client.indexOf('\n  }\n\n  private async updateNativeHandle', detachStart)
if (detachStart < 0 || detachEnd < 0) throw new Error('Detached Hook production anchor is absent.')
const detached = client.slice(detachStart, detachEnd)
const late = '      if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) {\n        watch.observer.dispose()\n        return\n      }\n'
const sync = 'try { await syncSessionDatabase(this.path) } catch (error) { throw new AgentMuxSessionDurabilityError(error) }'
const variants = [
  { name: 'candidate' },
  { name: 'await-auxiliary-again', path: 'packages/core/src/client.ts', anchor: detached,
    replacement: '    await this.ensureNativeStatusObservation(next)\n' + detached,
    target: 'acknowledges_confirmed_hook_before_auxiliary_setup_settles', expected: 'HOOK_DELIVERY_TIMEOUT',
    required: ['503', 'accepted', 'unknown', 'owner'] },
  { name: 'forget-sync-unconfirmed', path: 'packages/core/src/agent-session-store.ts', anchor: sync,
    replacement: 'try { await syncSessionDatabase(this.path) } catch (error) { /* controlled mutant loses durability uncertainty */ }',
    target: 'keeps_readable_sqlite_receipt_unknown_after_real_commit_when_sync_fails', expected: 'expected 204 to be 503' },
  { name: 'lose-detached-producer-rejection', path: 'packages/core/src/client.ts', anchor: detached,
    replacement: '    void this.ensureNativeStatusObservation(next)',
    target: 'contains_detached_provider_lookup_rejection_without_changing_confirmed_receipt', expected: 'expected false to be true' },
  { name: 'leak-late-setup-handle', path: 'packages/core/src/client.ts', anchor: late, replacement: '',
    target: 'disposes_late_auxiliary_setup_handle_disconnect', expected: 'to be called 1 times' }
]
function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', (code, signal) => resolveRun({ command, args, code, signal, stdout, stderr }))
  })
}
const cliRoot = join(attempt, 'cli')
await mkdir(join(cliRoot, 'bin'), { recursive: true }); await mkdir(join(cliRoot, 'dist'), { recursive: true })
await writeFile(join(cliRoot, 'package.json'), '{"type":"module"}')
await copyFile(join(root, 'packages/core/bin/amux'), join(cliRoot, 'bin/amux'))
await bind('packages/core/bin/amux')
async function bundle(options, variant) {
  let transformed = null
  const result = await build({ bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
    alias, metafile: true, logLevel: 'warning', ...options, plugins: [{ name: 'exact-existing-dependencies', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, async args => {
        if (isBuiltin(args.path) || alias[args.path]) return null
        const require = createRequire(args.importer || join(root, 'packages/core/package.json'))
        let entry
        try { entry = require.resolve(args.path) } catch (error) {
          const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
          for (const search of require.resolve.paths(name) ?? []) {
            const manifest = join(search, name, 'package.json')
            try {
              const pkg = JSON.parse(await readFile(manifest, 'utf8')), key = parts.length ? './' + parts.join('/') : '.'
              const shape = pkg.exports?.[key], target = typeof shape === 'string' ? shape : shape?.import
              if (!target) continue
              entry = resolve(dirname(manifest), target); await stat(entry); await bind(manifest); break
            } catch {}
          }
          if (!entry) throw error
        }
        await bind(entry)
        return { path: entry, external: true }
      })
    } }, ...(variant?.path ? [{ name: variant.name, setup(plugin) {
      plugin.onLoad({ filter: /\.ts$/ }, async args => {
        if (args.path !== resolve(root, variant.path)) return null
        const source = await readFile(args.path, 'utf8')
        if (source.split(variant.anchor).length !== 2) throw new Error('Mutation anchor must occur exactly once: ' + variant.name)
        transformed = source.replace(variant.anchor, variant.replacement)
        await writeFile(join(attempt, variant.name + '.transformed.ts'), transformed)
        return { contents: transformed, loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] : [])] })
  for (const path of Object.keys(result.metafile.inputs)) if (path !== '<stdin>') await bind(path)
  return { bytes: (await stat(options.outfile)).size, sha256: sha(await readFile(options.outfile)),
    sourceInputs: Object.keys(result.metafile.inputs), transformedSha256: transformed === null ? null : sha(transformed) }
}
receipt.cli = await bundle({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(cliRoot, 'dist/agentmux.js') })
const entry = [
  'export * from ' + JSON.stringify(join(root, 'packages/core/src/index.ts')),
  'export { sendHookReceipt } from ' + JSON.stringify(join(root, 'packages/core/src/agent-hook-delivery.ts')),
  'export { AgentMuxRpcService } from ' + JSON.stringify(join(root, 'packages/core/src/public-rpc-service.ts')),
  'export { AgentMuxHostedRuntimeService } from ' + JSON.stringify(join(root, 'packages/core/src/hosted-runtime-service.ts')),
  'export { AgentMuxHostedTransferReader } from ' + JSON.stringify(join(root, 'packages/core/src/hosted-value.ts'))
].join('\n')
await writeFile(join(attempt, 'compiled-entry.ts'), entry)
const vitest = createRequire(new URL('../../../package.json', import.meta.url)).resolve('vitest/vitest.mjs')
await bind(vitest)
for (const variant of variants) {
  const file = join(attempt, variant.name + '.mjs')
  const compiled = await bundle({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
  const report = join(attempt, variant.name + '.json')
  const args = [vitest, 'run', '--config', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
    '--reporter=json', '--outputFile=' + report]
  if (variant.target) args.push('-t', variant.target)
  const executed = await run(process.execPath, args, { AMX_HOOK_CORE_ENTRY: pathToFileURL(file).href,
    AMX_HOOK_OBJECT_CLI: join(cliRoot, 'bin/amux'), PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' })
  await writeFile(join(attempt, variant.name + '.log'), executed.stdout + executed.stderr)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const assertions = result.testResults.flatMap(suite => suite.assertionResults)
  const failure = assertions.find(row => row.fullName === variant.target && row.status === 'failed')
  const semanticRed = !!variant.target && executed.code === 1 && executed.signal === null &&
    failure?.failureMessages.some(message => message.includes(variant.expected) &&
      (variant.required ?? []).every(part => message.includes(part))) === true
  const record = { name: variant.name, compiled, executed: { ...executed, stdout: undefined, stderr: undefined },
    report, passed: result.numPassedTests, failed: result.numFailedTests, total: result.numTotalTests,
    semanticRed, failureName: failure?.fullName, failureMessages: failure?.failureMessages }
  if (!variant.target) {
    receipt.candidate = record
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (executed.code !== 0 || executed.signal !== null || result.numTotalTests !== 10 || result.numPassedTests !== 10 || !result.success) throw new Error('Candidate actual nonempty fixture failed: ' + report)
  } else {
    receipt.mutants.push(record)
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (!semanticRed) throw new Error('Mutation is not qualified semantic RED: ' + variant.name)
  }
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
// The same strict owning graph includes source workspace dependencies. Preserve
// exact pre-existing cross-package diagnostics rather than hiding or fixing them.
const ts = createRequire(new URL('../package.json', import.meta.url))('typescript')
const typePaths = Object.fromEntries(Object.entries(alias).map(([name, path]) => [name, [path]]))
typePaths.react = [join(root, 'apps/desktop/node_modules/@types/react/index.d.ts')]
typePaths['react/*'] = [join(root, 'apps/desktop/node_modules/@types/react/*')]
typePaths['react-dom/*'] = [join(root, 'apps/desktop/node_modules/@types/react-dom/*')]
const typeConfig = { extends: join(root, 'tsconfig.base.json'), compilerOptions: { rootDir: root, noEmit: true,
  jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler', types: ['node'],
  typeRoots: [join(root, 'packages/core/node_modules/@types')], baseUrl: root, paths: typePaths },
  files: [join(root, 'packages/core/test/hook-postcommit-observation.test.ts'), join(root, 'apps/desktop/src/renderer/src/global.d.ts')] }
await writeFile(join(attempt, 'typecheck-config.json'), JSON.stringify(typeConfig, null, 2))
await bind('tsconfig.base.json'); await bind('packages/relay/tsconfig.json')
const parsed = ts.parseJsonConfigFileContent(typeConfig, ts.sys, root)
if (parsed.errors.length) throw new Error('Owning typecheck configuration is invalid.')
const previous = await run('git', ['show', 'HEAD:packages/core/src/client.ts'], {})
if (previous.code !== 0 || previous.signal !== null || !previous.stdout.includes('private async acceptHookEvent')) throw new Error('Exact production baseline unavailable.')
function diagnostics(originalClient) {
  const host = ts.createCompilerHost(parsed.options)
  if (originalClient) {
    const getSource = host.getSourceFile.bind(host)
    host.getSourceFile = (path, version, error, fresh) => resolve(path) === join(root, 'packages/core/src/client.ts')
      ? ts.createSourceFile(path, originalClient, version, true) : getSource(path, version, error, fresh)
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  return { sources: program.getSourceFiles().filter(file => file.fileName.startsWith(root) && !file.fileName.includes('/node_modules/')).map(file => file.fileName),
    rows: ts.getPreEmitDiagnostics(program).map(row => ({ path: row.file ? relative(root, row.file.fileName) : null,
      code: row.code, start: row.start, message: ts.flattenDiagnosticMessageText(row.messageText, '\n') })) }
}
const actualTypes = diagnostics(), baselineTypes = diagnostics(previous.stdout)
for (const path of actualTypes.sources) await bind(path)
receipt.typecheck = { config: join(attempt, 'typecheck-config.json'), strict: parsed.options.strict,
  noUncheckedIndexedAccess: parsed.options.noUncheckedIndexedAccess, actual: actualTypes.rows, baseline: baselineTypes.rows,
  baselineClientSha256: sha(previous.stdout), actualEqualsBaseline: JSON.stringify(actualTypes.rows) === JSON.stringify(baselineTypes.rows),
  ownedDiagnostics: actualTypes.rows.filter(row => owned.includes(row.path)) }
await writeFile(join(attempt, 'typecheck.json'), JSON.stringify(receipt.typecheck, null, 2))
if (!receipt.typecheck.actualEqualsBaseline || receipt.typecheck.ownedDiagnostics.length ||
  actualTypes.rows.some(row => !row.path?.startsWith('packages/relay/src/'))) throw new Error('Owning strict typecheck changed or has owned diagnostics.')
const callerAnchors = [
  ['packages/core/src/client.ts', 'async (event, signal) => await this.acceptHookEvent(event, signal)', 'original Hook server consumer'],
  ['packages/core/src/hook-server.ts', 'withHookDeliveryDeadline', 'actual HTTP owner deadline'],
  ['packages/core/src/public-rpc-service.ts', 'await client.statusAgent(session.agentSessionId)', 'public agent.inspect owner retry'],
  ['packages/core/src/hosted-runtime-service.ts', "method === 'runtime.events'", 'public hosted event subscription'],
  ['packages/core/src/agentmux-cli-commands.ts', "'agent.inspect'", 'compiled CLI canonical method'],
  ['apps/desktop/src/renderer/src/store.ts', 'runtimeDiagnosticNotice(useAppStore.getState(), pending.event)', 'actual Desktop diagnostic notice consumer'],
  ['apps/desktop/src/renderer/src/lib/composer-submit-mode.ts', 'canSubmit', 'healthy input projection'],
  ['apps/desktop/src/renderer/src/components/TransientErrorNotice.tsx', "ariaLive === 'assertive' ? 'alert' : 'status'", 'visible nonblocking notice']
]
for (const [path, anchor, purpose] of callerAnchors) {
  const source = await read(path)
  if (!source.includes(anchor)) throw new Error('Actual product caller absent: ' + path + ' / ' + anchor)
  await bind(path); receipt.callers.push({ path, anchor, purpose, sha256: sha(source) })
}
for (const path of ['packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/hosted-runtime-port.ts',
  'apps/desktop/src/renderer/src/lib/session-state.ts']) await bind(path)
receipt.inputs = Object.fromEntries([...inputs].map(([path, hash]) => [relative(root, path), hash]))
receipt.sourceStable = (await Promise.all([...inputs].map(async ([path, hash]) => sha(await readFile(path)) === hash))).every(Boolean)
receipt.qualified = receipt.sourceStable && receipt.callers.length === callerAnchors.length && receipt.mutants.length === 4 && receipt.mutants.every(row => row.semanticRed)
await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
await writeFile(join(output, 'latest.json'), JSON.stringify({ attempt, receipt: join(attempt, 'receipt.json'), sha256: sha(await readFile(join(attempt, 'receipt.json'))) }, null, 2))
console.log(JSON.stringify({ qualified: receipt.qualified, candidate: receipt.candidate.passed, semanticRed: receipt.mutants.length,
  callers: receipt.callers.length, sourceStable: receipt.sourceStable, receipt: join(attempt, 'receipt.json') }))
if (!receipt.qualified) process.exitCode = 1
} catch (error) {
  receipt.qualified = false
  receipt.failure = { message: error instanceof Error ? error.message : String(error), stage: 'qualification' }
  receipt.inputs = Object.fromEntries([...inputs].map(([path, hash]) => [relative(root, path), hash]))
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.error(JSON.stringify({ qualified: false, receipt: join(attempt, 'receipt.json'), failure: receipt.failure }))
  process.exitCode = 1
}
