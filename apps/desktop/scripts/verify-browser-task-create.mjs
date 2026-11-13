import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, copyFile, readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const { build: renderer } = await import(pathToFileURL(require.resolve('vite')))
const electron = require('electron'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const outRoot = join(root, '.tmp/browser-task-create'); await mkdir(outRoot, { recursive: true })
const out = await mkdtemp(join(outRoot, 'attempt-')), fixture = join(root, 'apps/desktop/scripts/fixtures/browser-task-create')
const receipt = { schema: 'agentmux.browser-task-create.native-ui.v1', passed: false, sources: {}, transformed: {}, out,
  dependency: { electron: await realpath(electron), sha256: sha(await readFile(electron)), version: require('electron/package.json').version },
  boundary: 'Private Electron surface with production task Editor/Notice/styles and GUI orchestration; private preload calls original Manager and FileStore owners. Source is a nonempty Main fixture. Workbench hard persistence and process restart are proven separately by the owner gate; this capture proves real native input, reply loss and Renderer remount without a second asset.' }
let home, probe
try {
  await renderer({ configFile: false, root: fixture, base: './', logLevel: 'warn',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'task-ui-owning-sources', async transform(code, id) {
      const file = id.split('?')[0]
      if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
        receipt.sources[relative(root, file)] = sha(await readFile(file))
        receipt.transformed[relative(root, file)] = sha(code)
      }
    } }], build: { outDir: join(out, 'renderer'), emptyOutDir: false } })
  await symlink(join(root, 'apps/desktop/node_modules'), join(out, 'node_modules'))
  await bundle({ entryPoints: [join(fixture, 'main.ts')], outfile: join(out, 'main.mjs'), platform: 'node',
    format: 'esm', target: 'node24', bundle: true, packages: 'external',
    banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
    plugins: [{ name: 'task-main-owning-sources', setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
        const code = await readFile(args.path, 'utf8'); receipt.sources[relative(root, args.path)] = sha(code)
        return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }] })
  for (const file of ['apps/desktop/src/main/browser-task-assets.ts', 'apps/desktop/src/main/browser-view-manager.ts',
    'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx', 'apps/desktop/src/renderer/src/components/BrowserTaskCreationNotice.tsx',
    'apps/desktop/src/renderer/src/lib/browser-task-creation.ts', 'apps/desktop/src/renderer/src/styles/index.css']) {
    assert.ok(receipt.sources[file], 'Actual production consumer: ' + file)
  }
  const styles = join(out, 'renderer/assets'), css = (await readdir(styles)).filter(file => file.endsWith('.css'))
  assert.ok(css.length, 'The production style entry has emitted CSS')
  assert.match((await Promise.all(css.map(file => readFile(join(styles, file), 'utf8')))).join('\n'), /\.browser-task-asset-entry/u)
  for (const name of ['browser-task-assets.css', 'browser-operation-surface.css']) {
    const file = 'apps/desktop/src/renderer/src/styles/' + name
    receipt.sources[file] = sha(await readFile(join(root, file)))
  }
  await copyFile(join(fixture, 'preload.cjs'), join(out, 'preload.cjs'))
  receipt.sources[relative(root, join(fixture, 'preload.cjs'))] = sha(await readFile(join(fixture, 'preload.cjs')))
  home = await mkdtemp('/tmp/amux-task-create-ui-')
  const bootstrap = join(out, 'bootstrap.cjs')
  await writeFile(bootstrap, `console.error('task-stage: Electron boot');const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const home=${JSON.stringify(home)};for(const key of ['home','appData','userData','sessionData']){const p=path.join(home,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>{console.error('task-stage: Electron ready');return import(${JSON.stringify(pathToFileURL(join(out, 'main.mjs')).href)})}).catch(e=>{console.error(e);app.exit(1)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { TASK_CREATE_HOME: home, TASK_CREATE_OUT: out, TASK_CREATE_PAGE: join(out, 'renderer/index.html') })
  const logs = []
  // The observed Main import consumes about a minute on this host. This single
  // round also loads/reloads the real UI and paints wide/narrow/remounted receipts.
  probe = await runProbeProcess(electron, [bootstrap], { cwd: home, env, timeoutMs: 150_000, onLine: line => { logs.push(line); console.log(line) } })
  await writeFile(join(out, 'native.log'), logs.join('\n'))
  await stopProbeProcesses(probe.originalPid, home)
  receipt.process = probe; receipt.remaining = await listProbeProcesses(probe.originalPid, home)
  receipt.actual = JSON.parse(await readFile(join(out, 'actual.json'), 'utf8'))
  assert.equal(probe.timedOut, false); assert.equal(probe.exitCode, 0, JSON.stringify(receipt.actual.failure))
  assert.deepEqual(receipt.remaining, []); assert.deepEqual(receipt.actual.cleanup, []); assert.equal(receipt.actual.passed, true)
  for (const capture of receipt.actual.captures) capture.sha256 = sha(await readFile(capture.file))
  receipt.passed = true
} finally {
  if (probe && home) {
    await stopProbeProcesses(probe.originalPid, home)
    receipt.remaining = await listProbeProcesses(probe.originalPid, home)
    if (!receipt.remaining.length) { await rm(home, { recursive: true, force: true }); receipt.privateHomeRemoved = true }
  }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
