import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url)), { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/browser-contextual-input')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), packageRoot = join(attempt, 'package'), dist = join(packageRoot, 'dist')
await mkdir(dist, { recursive: true })
for (const name of ['bin', 'vendor', 'package.json']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
const hash = value => createHash('sha256').update(value).digest('hex'), sourceHashes = new Map(), alias = {}
async function bind(path) {
  const full = resolve(root, path), value = hash(await readFile(full))
  if (sourceHashes.has(full)) assert.equal(sourceHashes.get(full), value, 'Source changed during proof: ' + relative(root, full))
  sourceHashes.set(full, value)
}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  for (const [key, spec] of Object.entries(pkg.exports ?? {})) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (!target?.startsWith('./dist/')) continue
    const path = resolve(dirname(manifest), target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(path); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = path } catch {}
  }
}
const variants = [
  { name: 'candidate' },
  { name: 'remove-submit-service', path: 'public-rpc-service.ts',
    from: "const receipt = await scope.client.submitAgentPrompt({ ...input, sourceChannel: context.transport === 'unix' ? 'cli' : 'api',\n          ...(device ? { sourceDevice: normalizeOperationDevice(device) } : {}) }, this.inputCallContext(context))",
    to: 'const receipt = undefined', expected: 'original body survived the public producer' },
  { name: 'remove-strict-input-codec', path: 'agent-input-submit.ts', from: 'const p = rpcRecord(value, AGENT_INPUT_SUBMIT_FIELDS)', to: 'const p = rpcRecord(value)', expected: 'strict codec must reject authorHuman' },
  { name: 'recompose-frozen-input', path: 'client.ts', from: 'const outbound = retainWire ? frozen.prompt : waitingSource?.promptWire ?? composed.text', to: 'const outbound = composed.text', expected: 'formatter changes cannot rewrite original waiting wire' },
  { name: 'remove-original-input-query', path: 'public-rpc-service.ts', from: 'result = { record: original, ...(input ? { input } : {}) }; break', to: 'result = { record: null, ...(input ? { input } : {}) }; break', expected: 'CLI original inspect' },
  { name: 'remove-context-producer', path: 'agent-outbound-message.ts', from: 'if (input.inputContext) segments.push(', to: 'if (false) segments.push(', expected: 'unique reader consumes the actual Provider wire' },
  { name: 'remove-context-reader', path: 'agent-message-render.ts', from: 'declaredContexts.push({ raw, ...(inputContext ? { inputContext } : {}) })', to: 'declaredContexts.push({ raw })', expected: 'unique reader consumes the actual Provider wire' },
  { name: 'restored-candidate' }
]
const changedProducer = { path: 'agent-outbound-message.ts', from: '${browserInputContextJson(input.inputContext)}', to: '${browserInputContextJson(input.inputContext)} ' }
async function bundle(options, transforms = []) {
  const applied = new Set()
  const result = await build({ ...options, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', alias, metafile: true, logLevel: 'warning', plugins: [{ name: 'actual-source', setup(plugin) {
    plugin.onResolve({ filter: /^[^./]/ }, async args => {
      if (isBuiltin(args.path) || alias[args.path]) return null
      const resolver = createRequire(args.importer || join(root, 'packages/core/package.json'))
      let entry
      const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
      for (const directory of resolver.resolve.paths(name) ?? []) {
          try {
            const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
            const spec = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (!parts.length ? pkg.exports : undefined)
            const target = typeof spec === 'string' ? spec : typeof spec?.import === 'string' ? spec.import : spec?.import?.default
            if (!target) continue
            entry = resolve(dirname(manifest), target); await stat(entry); await bind(manifest); break
          } catch {}
      }
      entry ??= resolver.resolve(args.path)
      return { path: entry, external: true }
    })
    plugin.onLoad({ filter: /\.ts$/ }, async args => {
      const changes = transforms.filter(item => args.path === join(root, 'packages/core/src', item.path))
      if (!changes.length) return null
      let contents = await readFile(args.path, 'utf8')
      for (const item of changes) { assert.equal(contents.split(item.from).length, 2, 'Unique production anchor: ' + item.path); contents = contents.replace(item.from, item.to); applied.add(item) }
      return { contents, loader: 'ts', resolveDir: dirname(args.path) }
    })
  } }] })
  for (const item of transforms) assert.ok(applied.has(item), 'Mutation was actually loaded: ' + item.path)
  for (const path of Object.keys(result.metafile.inputs)) if (path !== '<stdin>') await bind(path)
}
const entrySource = [
  'export * from "./packages/core/src/index.ts"',
  'export { AgentMuxControlServer } from "./packages/core/src/public-rpc-server.ts"',
  'export { composeAgentPrompt } from "./packages/core/src/agent-outbound-message.ts"',
  'export { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from "./packages/core/src/agent-message-render.ts"'
].join('\n')
async function run(args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; child.stdout.on('data', data => { text += data }); child.stderr.on('data', data => { text += data })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private proof observation expired: ' + args[0])) }, 120000)
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, text }) })
  })
}
async function cleanPrivateDaemon(directory) {
  const listing = await new Promise((resolve, reject) => {
    const child = spawn('/bin/ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''
    child.stdout.on('data', data => { text += data }); child.once('error', reject); child.once('close', code => code ? reject(new Error('Private process inventory failed')) : resolve(text))
  })
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (match && match[2].includes('/ctxmuxd ') && match[2].includes('--socket ' + join(directory, 'runtime', 'ctxmux.sock')) && match[2].includes('--state-dir ' + join(directory, 'state', 'ctxmux'))) {
      process.kill(Number(match[1]), 'SIGTERM')
    }
  }
}
const receipt = { schema: 'agentmux.browser-contextual-input-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'SDK and compiled actual amux CLI → RPC → original Core prompt coordinator → shipped CodexProvider → real ctxmux PTY and controlled CLI subprocess',
    upstream: 'Controlled repository fake-codex-cli.mjs, not the upstream Codex CLI/service or model', userRuntimeTouched: false } }
await bind(import.meta.filename); await bind('packages/core/test/fixtures/browser-contextual-input.mjs'); await bind('packages/core/test/fixtures/fake-codex-cli.mjs')
let failure
try {
  await bundle({ entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(dist, 'control-endpoint-listener-worker.js') })
  for (const variant of variants) {
    const transforms = variant.from ? [variant] : [], entry = join(dist, 'candidate.mjs'), changed = join(dist, 'changed.mjs'), cli = join(dist, 'agentmux.js')
    await bundle({ stdin: { contents: entrySource, loader: 'ts', resolveDir: root }, outfile: entry }, transforms)
    await bundle({ stdin: { contents: entrySource, loader: 'ts', resolveDir: root }, outfile: changed }, [...transforms, changedProducer])
    await bundle({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli }, transforms.filter(item => ['agent-input-submit.ts'].includes(item.path)))
    const directory = await mkdtemp(join(tmpdir(), 'amx-bctx-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
    let result
    try { result = await run([join(root, 'packages/core/test/fixtures/browser-contextual-input.mjs'), pathToFileURL(entry).href, pathToFileURL(changed).href, cli, directory, join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs')], env) }
    finally { await cleanPrivateDaemon(directory) }
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const semanticRed = variant.from && result.code !== 0 && !result.signal && result.text.includes('AssertionError') && result.text.includes(variant.expected)
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, semanticRed: Boolean(semanticRed),
      ...(result.code === 0 ? { actual: JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) } : {}),
      productionMutation: variant.from ? { path: variant.path, before: hash(variant.from), after: hash(variant.to) } : null })
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (variant.from) assert.ok(semanticRed, variant.name + ' must fail its semantic oracle; see ' + join(attempt, variant.name + '.log'))
    else assert.equal(result.code, 0, variant.name + ' actual consumer failed: ' + result.text)
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(JSON.stringify({ variant: variant.name, semanticRed: Boolean(semanticRed), code: result.code }) + '\n')
  }
  for (const [path, before] of sourceHashes) assert.equal(hash(await readFile(path)), before, 'Source changed during proof: ' + relative(root, path))
  receipt.sourceStable = true; receipt.passed = true
} catch (error) { failure = error; receipt.failure = error.stack ?? String(error) }
finally {
  receipt.sources = Object.fromEntries([...sourceHashes].map(([path, sha256]) => [relative(root, path), sha256]))
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(packageRoot, { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(attempt, 'receipt.json'), failure: receipt.failure }))
if (failure) process.exitCode = 1
