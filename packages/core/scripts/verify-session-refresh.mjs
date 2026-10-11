import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = new Map()
async function bind(path) {
  const absolute = resolve(root, path), digest = sha(await readFile(absolute))
  if (inputs.has(absolute) && inputs.get(absolute) !== digest) throw new Error('Verification input changed: ' + path)
  inputs.set(absolute, digest)
}
const files = ['packages/core/src/agent-session-registry.ts', 'packages/core/src/client.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/test/session-refresh.test.ts', 'packages/core/test/session-refresh.config.mts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/scripts/verify-session-refresh.mjs']
for (const file of files) await bind(file)
const output = join(root, 'packages/core/.tmp/session-refresh')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
await symlink(join(root, 'packages/core/node_modules'), join(attempt, 'node_modules'), 'dir')
await writeFile(join(attempt, 'package.json'), JSON.stringify({ name: '@agentmux/core', type: 'module', exports: { '.': './baseline.mjs' } }))
const receipt = { schema: 'agentmux.session-refresh-proof.v1', attempt, qualified: false, sourceStable: false,
  scope: { actual: 'FileStore + Core registry + Hosted/public RPC + compiled production CLI',
    controlled: 'Runtime port and Provider native lookup; no user Runtime or process touched',
    lifecycleSideEffects: false, synchronousIdentityPromised: false }, baseline: null, mutants: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
await save()
try {
  const alias = {}
  for (const name of await readdir(join(root, 'packages'))) {
    const path = join(root, 'packages', name, 'package.json')
    let pkg; try { pkg = JSON.parse(await readFile(path, 'utf8')) } catch { continue }
    await bind(path)
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const entry = typeof value === 'string' ? value : value.import
      if (!entry?.startsWith('./dist/')) continue
      const source = resolve(dirname(path), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
      try { await stat(source); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
    }
  }
  const variants = [
    { name: 'baseline' },
    { name: 'canonical-requires-old-run', path: 'packages/core/src/agent-session-registry.ts',
      anchor: 'if (expectedRun && !sameRun(current.run, expectedRun))', replacement: 'if (!sameRun(current.run, expectedRun ?? previous.run))',
      target: 'canonical SDK refresh reads one exact SID', expected: 'Agent Session changed before prompt Input' },
    { name: 'explicit-run-fence', path: 'packages/core/src/agent-session-registry.ts',
      anchor: 'if (expectedRun && !sameRun(current.run, expectedRun))', replacement: 'if (false)',
      target: 'canonical SDK refresh reads one exact SID', expected: 'promise resolved' },
    { name: 'canonical-host-fence', path: 'packages/core/src/agent-session-registry.ts',
      anchor: 'if (current.hostId !== previous.hostId)', replacement: 'if (false)',
      target: 'canonical SDK refresh rejects a changed original Host', expected: 'promise resolved' },
    { name: 'canonical-native-observer', path: 'packages/core/src/client.ts',
      anchor: 'this.hookNativeWitnesses.delete(session.run.runId)\n    this.queueNativeIdentityCapture(session)',
      replacement: "this.hookNativeWitnesses.delete(session.run.runId)\n    this.queueNativeIdentityCapture({ ...session, run: { runId: 'unconfirmed-reader-run' } })",
      target: 'refresh re-observes late native identity', expected: "expected undefined to be 'native-original'" },
    { name: 'public-uses-refresh-owner', path: 'packages/core/src/public-rpc-service.ts',
      anchor: 'const session = await selected.client.refreshAgentSession(agentSessionId)', replacement: 'const session = selected.session',
      target: 'real public RPC and compiled CLI explicitly refresh', expected: 'to be called 2 times' },
    { name: 'public-result-host', path: 'packages/core/src/public-rpc-service.ts',
      anchor: 'session.agentSessionId !== agentSessionId || session.hostId !== selected.session.hostId',
      replacement: 'session.agentSessionId !== agentSessionId',
      target: 'compiled CLI rejects a refresh owner returning a foreign Host', expected: 'expected +0 to be 1' },
    { name: 'wire-result-sid', path: 'packages/core/src/rpc-native-codec.ts',
      anchor: 'if (session.agentSessionId !== input.agentSessionId) fail()', replacement: 'if (false) fail()',
      target: 'the public wire reader refuses another Session', expected: 'promise resolved' },
    { name: 'complete-target-only', path: 'packages/core/src/public-rpc-service.ts',
      anchor: "const agentSessionId = rpcString(p.agentSessionId, 'Complete original Session ID')\n        const selected = await this.owner(agentSessionId)\n        if (selected.agentSessionId !== agentSessionId) throw new AgentMuxError(\n          'Session refresh requires the complete original Session ID.', 'INVALID_CONTROL_REQUEST')",
      replacement: "const requested = rpcString(p.agentSessionId, 'Complete original Session ID')\n        const selected = await this.owner(requested)\n        const agentSessionId = selected.agentSessionId",
      target: 'public refresh keeps complete target and ambiguity', expected: 'promise resolved' }
  ]
  const source = [
    'export * from ' + JSON.stringify(join(root, 'packages/core/src/index.ts')),
    'export { AgentMuxControlServer } from ' + JSON.stringify(join(root, 'packages/core/src/public-rpc-server.ts')),
    'export { AgentMuxRpcService } from ' + JSON.stringify(join(root, 'packages/core/src/public-rpc-service.ts')),
    'export { AgentMuxHostedRuntimeService } from ' + JSON.stringify(join(root, 'packages/core/src/hosted-runtime-service.ts'))
  ].join('\n')
  async function bundle(options, variant) {
    let transformed = false
    const result = await build({ bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
      alias, metafile: true, logLevel: 'warning', ...options, plugins: [
        { name: 'existing-package-dependencies', setup(plugin) {
          plugin.onResolve({ filter: /^[^./]/ }, async args => {
            if (isBuiltin(args.path) || alias[args.path] || isAbsolute(args.path)) return null
            const dependency = createRequire(args.importer || join(root, 'packages/core/package.json'))
            let entry
            try { entry = dependency.resolve(args.path) } catch (error) {
              const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
              for (const search of dependency.resolve.paths(name) ?? []) {
                try {
                  const manifest = join(search, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
                  const shape = pkg.exports?.[parts.length ? './' + parts.join('/') : '.']
                  const value = typeof shape === 'string' ? shape : shape?.import
                  if (!value) continue
                  entry = resolve(dirname(manifest), value); await stat(entry); await bind(manifest); break
                } catch {}
              }
              if (!entry) throw error
            }
            await bind(entry); return { path: entry, external: true }
          })
        } },
        ...(variant?.path ? [{ name: 'loaded-' + variant.name, setup(plugin) {
          plugin.onLoad({ filter: /\.ts$/ }, async args => {
            if (args.path !== resolve(root, variant.path)) return null
            const text = await readFile(args.path, 'utf8')
            if (text.split(variant.anchor).length !== 2) throw new Error('Mutation requires one exact anchor: ' + variant.name)
            transformed = true
            return { contents: text.replace(variant.anchor, variant.replacement), loader: 'ts', resolveDir: dirname(args.path) }
          })
        } }] : [])
      ] })
    if (variant?.path && !transformed) throw new Error('Mutation was not loaded: ' + variant.name)
    for (const file of Object.keys(result.metafile.inputs)) if (file !== '<stdin>') await bind(file)
    return { sha256: sha(await readFile(options.outfile)), transformed }
  }
  const cli = join(attempt, 'cli')
  await mkdir(join(cli, 'dist'), { recursive: true }); await mkdir(join(cli, 'bin'), { recursive: true })
  await writeFile(join(cli, 'package.json'), '{"type":"module"}')
  await copyFile(join(root, 'packages/core/bin/amux'), join(cli, 'bin/amux')); await bind('packages/core/bin/amux')
  await mkdir(join(attempt, 'dist'), { recursive: true })
  receipt.listener = await bundle({ entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(attempt, 'dist/control-endpoint-listener-worker.js') })
  receipt.cli = await bundle({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(cli, 'dist/agentmux.js') })
  const vitest = createRequire(join(root, 'package.json')).resolve('vitest/vitest.mjs')
  await bind(vitest)
  for (const variant of variants) {
    const file = join(attempt, variant.name + '.mjs')
    const compiled = await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const report = join(attempt, variant.name + '.json')
    const args = [vitest, 'run', '--config', 'packages/core/test/session-refresh.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
        AGENTMUX_TEST_REFRESH_CORE_ENTRY: file, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux') }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
      child.once('error', reject); child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.stdout + result.stderr)
    const summary = JSON.parse(await readFile(report, 'utf8'))
    const assertions = summary.testResults.flatMap(suite => suite.assertionResults)
    const failed = assertions.filter(row => row.status === 'failed')
    const semanticRed = variant.target && result.code === 1 && !result.signal && failed.some(row =>
      row.fullName.includes(variant.target) && (row.failureMessages.join('\n') + result.stdout + result.stderr).includes(variant.expected))
    const entry = { name: variant.name, compiled, code: result.code, signal: result.signal,
      total: summary.numTotalTests, passed: summary.numPassedTests, failed: summary.numFailedTests,
      semanticRed: !!semanticRed, report, failures: failed.map(row => ({ name: row.fullName, messages: row.failureMessages })) }
    if (!variant.target) {
      receipt.baseline = entry; await save()
      if (result.code !== 0 || result.signal || !summary.success || summary.numTotalTests !== 11 || summary.numPassedTests !== 11)
        throw new Error('Nonempty actual refresh baseline failed: ' + report)
    } else {
      receipt.mutants.push(entry); await save()
      if (!semanticRed) throw new Error('Loaded source mutation lacks its business failure: ' + variant.name)
    }
  }
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.qualified = true
  await save(); await mkdir(join(root, '.tmp/session-capability-recovery'), { recursive: true }); await writeFile(join(root, '.tmp/session-capability-recovery/refresh-latest.json'), JSON.stringify({ receipt: join(attempt, 'receipt.json') }, null, 2)); process.stdout.write('Session refresh passed: ' + join(attempt, 'receipt.json') + '\n')
} catch (error) {
  receipt.error = { message: error.message, stack: error.stack }; await save(); throw error
}
