import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, process.argv[2] ?? '.local/session-observation-bridge'), require = createRequire(resolve(root, 'apps/desktop/package.json'))
process.chdir(root)
const { build: bundle } = createRequire(require.resolve('vite'))('esbuild'), { build } = await import(require.resolve('vite')), electron = require('electron')
const fixture = resolve(root, 'apps/desktop/scripts/fixtures/session-observation-bridge')
const owned = ['apps/desktop/scripts/verify-session-observation-bridge.mjs', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  ...['main.ts', 'entry.tsx', 'index.html'].map(name => relative(root, join(fixture, name)))]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(owned.map(async path => [path, sha(await readFile(path))])))
const resources = [], checks = []
for (const variant of ['baseline', 'premature-unwrap', 'adapter-bypass']) {
  const out = join(evidence, 'bridge-' + variant); await mkdir(out, { recursive: true })
  const work = await mkdtemp(join(tmpdir(), 'amux-observation-bridge-')), loaded = [], artifacts = {}
  const load = async (file, source) => {
    const path = relative(root, file), original = await readFile(file), before = source ?? original.toString(); let output = before
    if (variant === 'premature-unwrap' && path === 'apps/desktop/src/preload/index.ts') {
      const anchor = "attach: (session: SessionControl, afterSequence = 0) => ipcRenderer.invoke('sessions:attach', session, afterSequence),"
      assert.equal(output.split(anchor).length, 2)
      output = output.replace(anchor, "attach: async (session: SessionControl, afterSequence = 0) => { const value = await ipcRenderer.invoke('sessions:attach', session, afterSequence); if (!value.ok) throw Object.assign(new Error(value.error.message), value.error); return value.result },")
    }
    if (variant === 'adapter-bypass' && path === 'apps/desktop/src/renderer/src/lib/api.ts') {
      const anchor = 'attach: (...args) => preload.sessions.attach(...args).then(unwrapSessionObservationResult),'
      assert.equal(output.split(anchor).length, 2); output = output.replace(anchor, 'attach: (...args) => preload.sessions.attach(...args),')
    }
    loaded.push({ path, originalSHA256: sha(original), sourceSHA256: sha(before), consumedSHA256: sha(output), mutation: output === before ? null : variant })
    return output
  }
  const plugin = { name: 'observation-source-binding', setup(builder) { builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
    if (args.path.includes('/node_modules/') || !args.path.startsWith(root + '/')) return
    return { contents: await load(args.path), loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: resolve(args.path, '..') }
  }) } }
  try {
    await bundle({ entryPoints: [join(fixture, 'main.ts')], outfile: join(work, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [plugin], logLevel: 'error' })
    await bundle({ entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(work, 'preload.cjs'), bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], plugins: [plugin], logLevel: 'error' })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      build: { target: 'esnext', outDir: join(work, 'renderer'), minify: false, emptyOutDir: true },
      plugins: [{ name: 'observation-page-source', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]; if (!file.startsWith(root + '/') || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(file)) return
        return { code: await load(file, code), map: null }
      } }] })
    for (const entry of loaded) if (owned.includes(entry.path)) assert.equal(entry.originalSHA256, inputs[entry.path], 'Owned candidate changed during compilation')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    let child, log = '', timedOut = false
    const outcome = await new Promise((done, reject) => {
      child = spawn(electron, [join(work, 'main.cjs'), work, out], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const record = { variant, root: work, pid: child.pid, runnerPid: process.pid, exited: false }; resources.push(record)
      writeFile(join(evidence, 'bridge-resources.json'), JSON.stringify(resources, null, 2) + '\n')
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data.toString() })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 45000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); record.exited = true; record.code = code; record.signal = signal; done({ code, signal }) })
    })
    await writeFile(join(out, 'run.log'), log)
    await writeFile(join(out, 'loaded.jsonl'), loaded.map(entry => JSON.stringify(entry) + '\n').join(''))
    assert.equal(timedOut, false, log)
    if (variant === 'baseline') {
      const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'))
      assert.equal(outcome.code, 0, JSON.stringify(result)); assert.equal(result.passed, 6); assert.equal(result.cases.length, 6)
    } else {
      const failure = JSON.parse(await readFile(join(out, 'failure.json'), 'utf8'))
      assert.equal(outcome.code, 1); assert.equal(failure.name, 'AssertionError')
      assert.match(failure.message, /Page-world observation code must survive both real Electron boundaries/)
      assert.equal(failure.passed, 0); assert.equal(failure.cases.length, 1)
      assert.ok(loaded.some(entry => entry.mutation === variant && entry.consumedSHA256 !== entry.sourceSHA256))
    }
    for (const path of ['main.cjs', 'preload.cjs']) artifacts[path] = sha(await readFile(join(work, path)))
    checks.push({ variant, outcome, loadedHash: sha(await readFile(join(out, 'loaded.jsonl'))), logHash: sha(await readFile(join(out, 'run.log'))), artifacts })
    console.log(variant + ': ' + (variant === 'baseline' ? '6 actual isolated cases GREEN' : 'actual page-world AssertionRED'))
  } finally { await rm(work, { recursive: true, force: true }); await writeFile(join(evidence, 'bridge-resources.json'), JSON.stringify(resources, null, 2) + '\n') }
}
for (const path of owned) assert.equal(sha(await readFile(path)), inputs[path], 'Owned source changed while proving bridge')
await writeFile(join(evidence, 'bridge-execution.json'), JSON.stringify({ ok: true, inputs, checks, scope: 'Actual hidden Electron contextIsolation, production preload+page API+original finite helper. No user app/Native/Run; existing mounted Main/PTY evidence is composed at the unchanged API boundary.' }, null, 2) + '\n')
