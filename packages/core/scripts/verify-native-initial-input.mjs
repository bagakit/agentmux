import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const plainOnly = process.argv.includes('--plain')
const { build } = require('esbuild'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = join(root, 'packages/core/.tmp/native-initial-input'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), packageRoot = join(attempt, 'package'), dist = join(packageRoot, 'dist')
await mkdir(dist, { recursive: true })
for (const name of ['vendor', 'package.json']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
const inputs = new Map(), alias = {}
async function bind(path) {
  path = resolve(root, path); const digest = sha(await readFile(path))
  if (inputs.has(path)) assert.equal(inputs.get(path), digest, 'Source changed during qualification: ' + path)
  inputs.set(path, digest)
}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json'); let pkg
  try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  await bind(manifest)
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : value.import
    if (!entry?.startsWith('./dist/')) continue
    const path = resolve(dirname(manifest), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    try { await stat(path); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = path } catch {}
  }
}
const guard = " &&\n              !(control?.onlyIfUnclaimed && control.requiredNativeSource && current.nativeSourceObservation.state === 'unknown')"
const variants = [{ name: 'candidate', count: plainOnly ? 1 : 9 },
  { name: 'old-unknown-guard', from: guard, to: '', target: 'plain cwd', count: 1 },
  { name: 'skip-frontend-prejoin', file: 'codex-managed-frontend.ts',
    from: "const joined = await connection.request('thread/resume', { threadId: target.sessionId, excludeTurns: false })",
    to: 'const joined = loaded', target: 'plain cwd', count: 1 },
  { name: 'skip-frontend-authorization', file: 'codex-managed-frontend.ts',
    from: '  await context.assertCurrent()\n  let result:', to: '  /* Cancelled preparation incorrectly dispatches control. */\n  let result:',
    target: 'plain cwd', count: 1 },
  { name: 'ignore-exact-source', from: 'if (control?.requiredNativeSource && !isDeepStrictEqual(source, control.requiredNativeSource)) return undefined',
    to: 'if (false) return undefined', target: 'refuses a different required Native object', count: 1 },
  { name: 'borrow-existing-claim', from: 'if (control?.onlyIfUnclaimed && original) throw new AgentMuxError(',
    to: 'if (false && original) throw new AgentMuxError(', target: 'the original admitted claim cannot be borrowed', count: 1 },
  { name: 'grant-question-exception', from: 'control?.onlyIfUnclaimed && control.requiredNativeSource', to: 'control?.requiredNativeSource',
    target: 'refuses ordinary-question', count: 1 }]
const receipt = { schema: 'agentmux.native-initial-input-proof.v1', passed: false, sourceStable: false, userRuntimeTouched: false,
  native: process.env.AGENTMUX_TEST_CODEX_EXECUTABLE ?? join(homedir(), '.codex/packages/app-server-daemon/releases', `0.163.0-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin/bin/codex`), results: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
async function bundle(options, variant) {
  let transformed = false
  const result = await build({ ...options, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', alias, metafile: true,
    logLevel: 'warning', plugins: [{ name: 'source-and-dependencies', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, async args => {
        if (isBuiltin(args.path) || alias[args.path]) return null
        const resolver = createRequire(args.importer || join(root, 'packages/core/package.json')); let entry
        try { entry = resolver.resolve(args.path) } catch (error) {
          const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
          for (const directory of resolver.resolve.paths(name) ?? []) {
            try { const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
              const shape = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'], value = typeof shape === 'string' ? shape : shape?.import
              if (!value) continue
              entry = resolve(dirname(manifest), value); await stat(entry); await bind(manifest); break
            } catch {}
          }
          if (!entry) throw error
        }
        const bare = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0]
        for (let directory = dirname(entry); args.path === bare && directory !== dirname(directory); directory = dirname(directory)) {
          try { const manifest = join(directory, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
            const shape = pkg.exports?.['.'] ?? pkg.exports, imported = shape?.import, value = typeof imported === 'string' ? imported : imported?.default
            if (value?.startsWith('./')) { entry = resolve(directory, value); await bind(manifest) }
            break
          } catch {}
        }
        await bind(entry); return { path: entry, external: true }
      })
      if (variant?.from) plugin.onLoad({ filter: /(?:prompt-submission|codex-managed-frontend)\.ts$/ }, async args => {
        if (!args.path.endsWith('/' + (variant.file ?? 'prompt-submission.ts'))) return null
        const source = await readFile(args.path, 'utf8')
        assert.equal(source.split(variant.from).length, 2, 'Unique owning mutation anchor: ' + variant.name)
        transformed = true
        receipt.transforms ??= []; receipt.transforms.push({ name: variant.name, path: relative(root, args.path), original: sha(source), loaded: sha(source.replace(variant.from, variant.to)) })
        return { contents: source.replace(variant.from, variant.to), loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] })
  if (variant?.from) assert.ok(transformed, 'Mutation did not load: ' + variant.name)
  for (const path of Object.keys(result.metafile.inputs)) if (path !== '<stdin>') await bind(path)
}
try {
  for (const path of ['packages/core/test/native-initial-input.integration.test.ts', 'packages/core/test/native-initial-input.config.mts',
    'packages/core/scripts/verify-native-initial-input.mjs', 'packages/core/test/helpers/headless-runtime-fixture.ts',
    'packages/core/test/helpers/codex-offline-endpoint.ts', 'packages/core/native/native-socket-peer.c', receipt.native,
    `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]) await bind(path)
  await promisify(execFile)('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', join(root, 'packages/core/native/native-socket-peer.c'),
    '-o', join(dist, 'native-socket-peer-darwin')], { maxBuffer: 1024 * 1024 })
  receipt.nativeProcessHelper = sha(await readFile(join(dist, 'native-socket-peer-darwin')))
  for (const name of ['codex-managed-run', 'control-endpoint-listener-worker']) await bundle({
    entryPoints: [join(root, 'packages/core/src', name === 'codex-managed-run' ? 'providers/' + name + '.ts' : name + '.ts')], outfile: join(dist, name + '.js') })
  const source = ['export * from "./packages/core/src/index.ts"',
    'export { AgentPromptSubmissionCoordinator } from "./packages/core/src/prompt-submission.ts"',
    'export { AgentMuxAgentSessionRegistry } from "./packages/core/src/agent-session-registry.ts"',
    'export { AgentMuxClientEventPublisher } from "./packages/core/src/client-event-publisher.ts"'].join('\n')
  const old = join(dist, 'old.mjs')
  await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: old }, variants[1])
  const owner = join(dist, 'owner.mjs')
  await writeFile(owner, `import {existsSync,appendFileSync} from 'node:fs';import{join}from'node:path';
const file=existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'use-candidate'))?${JSON.stringify(pathToFileURL(join(dist, 'current.mjs')).href)}:${JSON.stringify(pathToFileURL(old).href)};
const core=await import(file),candidate=existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'use-candidate'));
// Reproduce the client ordering: the real history consumer observes missing source
// before the old Core continues its original input. No observation is fabricated.
const original=core.AgentMuxClient.prototype.continueInitialInput;core.AgentMuxClient.prototype.continueInitialInput=async function(session,...args){
if(candidate){appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'original-input-held'),'entered\\n');while(existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'hold-original-input')))await new Promise(resolve=>setTimeout(resolve,10))}
else await this.sessionHistoryPage(session.agentSessionId,{refreshNativeSource:true,commandOverride:${JSON.stringify(receipt.native)},env:{CODEX_HOME:join(process.env.AGENTMUX_STATE_DIRECTORY,'..','codex-home')}}).catch(()=>{});
return original.call(this,session,...args)};
const owner=await core.startHeadlessAgentMux({socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock')});
const submission=owner.client.promptSubmission,send=submission.submitInputPlan.bind(submission);submission.submitInputPlan=async(...args)=>{try{return await send(...args)}catch(error){appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY,'initial-input-errors.ndjson'),JSON.stringify({name:error.name,code:error.code,message:error.message,stack:error.stack,cause:error.cause?String(error.cause):null})+'\\n');throw error}};
process.stdout.write(JSON.stringify({owner:owner.ownerIdentity(),socketPath:owner.socketPath})+'\\n');process.once('SIGTERM',()=>{void owner.stop()});\n`)
  for (const variant of process.argv.includes('--mutations') ? variants : variants.slice(0, 1)) {
    const file = join(dist, 'current.mjs'), report = join(attempt, variant.name + '.json'), evidence = join(attempt, variant.name + '-consumer.ndjson')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/native-initial-input.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (plainOnly) args.push('-t', 'plain cwd')
    else if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_OWNER_ENTRY: owner,
        AGENTMUX_NATIVE_INITIAL_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_CODEX_EXECUTABLE: receipt.native, AGENTMUX_PRIVATE_INITIAL_CANDIDATE: pathToFileURL(file).href,
        AGENTMUX_NATIVE_INITIAL_EVIDENCE: evidence }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', chunk => { text += chunk }); child.stderr.on('data', chunk => { text += chunk })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const active = assertions.filter(test => !['skipped', 'pending', 'todo'].includes(test.status)), failed = active.filter(test => test.status === 'failed')
    assert.equal(active.length, variant.count, 'Exact nonempty test inventory: ' + variant.name)
    assert.equal(failed.length, tests.numFailedTests, 'Failure rows equal report count')
    const semanticRed = result.code === 1 && !result.signal && failed.length > 0 && failed.every(test =>
      /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .+ to /su.test(test.failureMessages.join('\n')))
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, total: active.length, failed: failed.length,
      semanticRed, bundle: sha(await readFile(file)), failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (variant.from) assert.ok(semanticRed, 'Loaded source mutation failed without the required behavioral assertion: ' + variant.name)
    else {
      assert.equal(result.code, 0, 'Real Core/Native baseline failed: ' + report); assert.equal(tests.numPassedTests, variant.count)
      const consumers = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(consumers.map(value => value.mode), plainOnly ? ['plain'] : ['plain', 'git']); receipt.consumers = consumers
    }
    process.stdout.write(variant.name + ': ' + (variant.from ? 'assertion RED' : 'GREEN') + '\n')
  }
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; throw error }
finally { await save(); process.stdout.write(relative(root, join(attempt, 'receipt.json')) + '\n') }
