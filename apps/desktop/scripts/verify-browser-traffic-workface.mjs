import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build as buildRenderer } from 'vite'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const electron = require('electron')
const fixture = join(desktop, 'scripts/fixtures/browser-traffic')
const captureSource = 'apps/desktop/src/main/browser-traffic.ts'
const source = await readFile(join(root, captureSource), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const report = { passed: false, candidate: hash(source), variants: [] }
await mkdir(join(root, '.local'), { recursive: true })
const evidence = await mkdtemp(join(root, '.local/browser-traffic-'))
const compiled = join(evidence, 'compiled')
await mkdir(compiled)
await symlink(join(desktop, 'node_modules'), join(compiled, 'node_modules'))
const web = createServer((request, response) => {
  if (request.url === '/redirect') { response.writeHead(302, { Location: '/final' }); response.end(); return }
  response.setHeader('Content-Type', 'text/html')
  response.end(`<!doctype html><title>Original page ${request.url}</title><input value="Original draft">`)
})
web.listen(0, '127.0.0.1')
await once(web, 'listening')
try {
  await buildRenderer({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, worker: { format: 'es' },
    build: { outDir: join(compiled, 'renderer'), minify: false, sourcemap: false,
      rollupOptions: { input: join(fixture, 'index.html') } } })
  await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(compiled, 'preload.cjs'),
    platform: 'browser', format: 'cjs', target: 'node24', bundle: true, external: ['electron'], logLevel: 'silent' })
  for (const name of process.argv.includes('--mutations') ? ['original', 'missing-source', 'missing-notification', 'restored'] : ['original']) {
    const capture = join(evidence, name)
    await mkdir(capture)
    const module = join(compiled, `${name}.mjs`), boot = join(compiled, `${name}.cjs`)
    const result = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/scripts/fixtures/browser-traffic/main.ts'], outfile: module,
      bundle: true, platform: 'node', packages: 'external', metafile: true, format: 'esm', target: 'node24', logLevel: 'silent',
      banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
      plugins: name.startsWith('missing-') ? [{ name, setup(builder) {
        builder.onLoad({ filter: /[\\/]main[\\/]browser-traffic\.ts$/ }, args => {
          assert.equal(args.path, join(root, captureSource))
          const anchor = name === 'missing-source'
            ? 'const original = await this.ports.attach(source.target.id, controller.signal)'
            : 'this.capture = capture\n    this.ports.changed()'
          assert.equal(source.split(anchor).length, 2)
          const changed = source.replace(anchor, name === 'missing-source'
            ? "throw new Error('Mutated original native lease')"
            : 'this.capture = capture')
          return { contents: changed, loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }] : [] })
    for (const path of [captureSource, 'apps/desktop/src/main/browser-traffic-ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts'])
      assert.ok(Object.hasOwn(result.metafile.inputs, path), 'Native candidate consumes ' + path)
    const origin = await mkdtemp(join(tmpdir(), 'amux-native-traffic-'))
    await writeFile(boot, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const home=${JSON.stringify(origin)};for(const key of ['appData','userData','sessionData']){const p=path.join(home,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(module).href)})).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_TRAFFIC_HOME: origin, AGENTMUX_TRAFFIC_RENDERER: compiled, AGENTMUX_TRAFFIC_OUTPUT: capture,
      AGENTMUX_TRAFFIC_URL: `http://127.0.0.1:${web.address().port}` })
    let processReceipt
    try {
      processReceipt = await runProbeProcess(electron, [boot], { cwd: origin, env, timeoutMs: 60_000, onLine: line => console.log(line) })
      const bytes = await readFile(join(capture, 'result.json'), 'utf8').catch(() => { throw new Error('Traffic Electron receipt unavailable: ' + JSON.stringify(processReceipt)) })
      const actual = JSON.parse(bytes)
      report.variants.push({ name, process: processReceipt, actual, main: hash(await readFile(module)) })
      assert.equal(processReceipt.timedOut, false)
      assert.deepEqual(actual.cleanup, [])
      if (name.startsWith('missing-')) {
        assert.equal(actual.passed, false)
        assert.match(actual.failure, name === 'missing-source' ? /actual Traffic UI did not start/ : /second Traffic panel missed the start/)
      } else { assert.equal(actual.passed, true, actual.failure); assert.equal(processReceipt.exitCode, 0) }
    } finally {
      await stopProbeProcesses(processReceipt?.originalPid, origin)
      const remaining = await listProbeProcesses(processReceipt?.originalPid, origin)
      assert.deepEqual(remaining, [])
      await rm(origin, { recursive: true, force: true })
    }
  }
  assert.equal(hash(await readFile(join(root, captureSource))), report.candidate)
  report.passed = true
} finally {
  await new Promise(done => web.close(done))
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  await rm(compiled, { recursive: true, force: true })
  console.log('browser-traffic-receipt:', join(evidence, 'receipt.json'))
}
