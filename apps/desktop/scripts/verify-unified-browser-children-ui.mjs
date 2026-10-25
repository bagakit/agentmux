import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/unified-browser-children-ui')
const proofRoot = path.join(root, '.tmp/unified-browser-children-ui'), prepared = path.join(proofRoot, 'prepared')
const scenario = process.argv[3] === '--survey-alias' ? 'survey-alias' : 'unified-children'
assert.ok(process.argv.length <= 3 || process.argv.length === 4 && scenario === 'survey-alias', 'Use [output] [--survey-alias]')
const output = path.resolve(process.argv[2] ?? path.join(proofRoot, 'attempt-' + Date.now()))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amx-child-ui-')))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function files(folder) { return (await Promise.all((await fs.readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))).flat() }
async function fileHashes(paths) { return Object.fromEntries(await Promise.all(paths.map(async file => [path.relative(root, file), hash(await fs.readFile(file))]))) }
const sourcePaths = [path.join(desktop, 'src/main/browser-view-manager.ts'), path.join(desktop, 'src/main/browser-native-windows.ts'),
  path.join(desktop, 'src/main/workbench-windows.ts'), path.join(desktop, 'src/main/native-overlay-windows.ts'), path.join(desktop, 'src/preload/index.ts'),
  path.join(desktop, 'src/renderer/src/store.ts'), path.join(desktop, 'src/renderer/src/App.tsx'), path.join(desktop, 'src/renderer/src/components/BrowserPane.tsx'),
  path.join(desktop, 'src/renderer/src/components/BrowserSourceNavigation.tsx'), path.join(desktop, 'src/renderer/src/lib/browser-child-projection.ts'),
  path.join(desktop, 'src/renderer/src/lib/workbench-windows.tsx'), path.join(desktop, 'src/renderer/src/styles/browser.css'),
  path.join(desktop, 'src/renderer/src/components/StableWorkbenchView.tsx'), path.join(desktop, 'src/renderer/src/components/WorkspaceWorkbench.tsx'),
  path.join(desktop, 'src/renderer/src/lib/workbench-presentation.ts'),
  ...['entry.tsx', 'main.ts', 'survey-alias.ts', 'preload-bridge.cjs', 'index.html'].map(name => path.join(fixture, name)), import.meta.filename]
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const receipt = { schema: 'agentmux.unified-browser-children-ui.v1', scenario, passed: false, captureOnly: true, aestheticReview: 'not-performed', phases: [], images: [], sourceBefore: await hashes() }
const rendererInputs = await fileHashes([
  ...await files(path.join(desktop, 'src/renderer')), ...await files(path.join(desktop, 'src/shared')),
  ...await files(path.join(root, 'packages/client-ui/src')), ...await files(path.join(root, 'packages/layout/src')), ...await files(path.join(root, 'packages/core/dist')),
  ...await files(path.join(root, 'packages/native-desktop/dist')),
  path.join(fixture, 'entry.tsx'), path.join(fixture, 'index.html'), path.join(desktop, 'resources/icon-128.png'), path.join(root, 'pnpm-lock.yaml')
])
const httpRequests = []
const server = createServer(async (request, response) => {
  if (scenario === 'survey-alias') {
    const body = []; for await (const chunk of request) body.push(chunk)
    const requestBody = Buffer.concat(body).toString('utf8'), pathname = new URL(request.url, 'http://private.test').pathname
    httpRequests.push({ method: request.method, path: pathname, body: requestBody })
    const name = pathname === '/child-link' ? 'Link research' : pathname === '/child-post' ? 'Posted research' : pathname === '/sibling' ? 'Sibling research' : 'Original research'
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><meta charset="utf-8"><title>${name}</title><style>html,body{margin:0;background:#f1f5f3;color:#203d32;font:16px system-ui}main{max-width:680px;padding:40px}h1{font-size:28px;margin:12px 0}p{line-height:1.55;color:#5c7067}a,button,input{font:inherit}a,button{display:inline-block;margin:12px 16px 12px 0}button{background:#24644d;color:white;border:0;border-radius:6px;padding:10px 14px}input{display:block;width:320px;max-width:85%;padding:10px;border:1px solid #92aa9d;border-radius:6px}</style><main><small>PRIVATE SURVEY NAVIGATION PROOF</small><h1>${name}</h1><p id="method">${request.method} ${pathname}</p><p id="payload">${requestBody.replaceAll('&','&amp;').replaceAll('<','&lt;')}</p><label>Page draft<input id="page-draft" aria-label="Page draft" placeholder="Type on this exact page"></label>${pathname === '/source' ? '<a id="open-link" href="/child-link" target="_blank">Open linked research</a><form action="/child-post" method="post" target="_blank"><input type="hidden" name="proof" value="original-post-body"><button id="open-post" type="submit">Open posted research</button></form>' : '<p>This independent page stays readable and editable while switching Survey Tabs.</p>'}</main>`)
    return
  }
  response.setHeader('content-type', 'text/html; charset=utf-8')
  const child = request.url === '/child'
  response.end(`<!doctype html><meta charset="utf-8"><title>${child ? 'Related task' : 'Original research page'}</title><style>html,body{margin:0;background:#f1f5f3;color:#203d32;font:15px system-ui}main{max-width:660px;padding:42px}h1{font-size:29px;font-weight:650;margin:0 0 16px}p{line-height:1.6;color:#5c7067}button{font:inherit;background:#24644d;color:white;border:0;border-radius:7px;padding:11px 16px;margin-top:12px}</style><main><small>BROWSER WORKFACE · PRIVATE UI PROOF</small><h1>${child ? 'Related task' : 'Original research page'}</h1><p>${child ? 'This page was opened by the original document. Its page identity and full Browser controls stay together.' : 'Keep this original page and its exact Region while opening a related task in another window.'}</p>${child ? '<button id="continue">Continue review</button>' : '<button id="open-child" onclick="window.open(\'/child\',\'_blank\',\'width=840,height=620\')">Open related task</button>'}</main>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${server.address().port}/source`
await fs.mkdir(output, { recursive: true })
try {
  await fs.mkdir(path.join(prepared, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(prepared, 'node_modules/@agentmux/core')).catch(error => { if (error.code !== 'EEXIST') throw error })
  const previewBoundary = { name: 'existing-preview-service-boundary-only', enforce: 'pre', transform(code, id) {
    if (id !== path.join(desktop, 'src/renderer/src/lib/api.ts')) return
    const anchor = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
    assert.equal(code.split(anchor).length, 2, 'One existing preview service boundary')
    const changed = code.replace(anchor, 'export const api = true ? mockApi : requireDesktopApi()')
    receipt.previewApiBoundary = { original: hash(code), compiled: hash(changed), scope: 'Existing unrelated preview services only; Browser and native-window methods are replaced with actual preload APIs before App mounts. All product presentation feature flags remain production false.' }
    return { code: changed, map: null }
  } }
  const previous = await fs.readFile(path.join(prepared, 'renderer-inputs.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (previous && JSON.stringify(previous.inputs) === JSON.stringify(rendererInputs)) {
    assert.deepEqual(await fileHashes(await files(path.join(prepared, 'renderer'))), previous.compiled, 'The original cached Renderer remains byte-identical')
    receipt.previewApiBoundary = previous.previewApiBoundary; receipt.rendererReused = true
  } else {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [previewBoundary], worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
      build: { target: 'esnext', minify: false, outDir: path.join(prepared, 'renderer'), emptyOutDir: true } })
    await fs.copyFile(path.join(desktop, 'src/renderer/workbench-window.html'), path.join(prepared, 'renderer/workbench-window.html'))
    const compiled = await fileHashes(await files(path.join(prepared, 'renderer')))
    await fs.writeFile(path.join(prepared, 'renderer-inputs.json'), JSON.stringify({ inputs: rendererInputs, compiled, previewApiBoundary: receipt.previewApiBoundary }))
    receipt.rendererReused = false
  }
  receipt.renderer = JSON.parse(await fs.readFile(path.join(prepared, 'renderer-inputs.json'), 'utf8'))
  const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite')).href)
  const originalCwd = process.cwd()
  try {
    process.chdir(desktop)
    const resolved = await resolveConfig({ root: desktop, configFile: path.join(desktop, 'electron.vite.config.ts') }, 'build', 'production')
    await build({ ...resolved.config.preload, configFile: false, build: { ...resolved.config.preload.build, outDir: path.join(prepared, 'product-preload'), emptyOutDir: true } })
    const originalPreload = await fs.readFile(path.join(prepared, 'product-preload/index.cjs'), 'utf8')
    const privateBridge = await fs.readFile(path.join(fixture, 'preload-bridge.cjs'), 'utf8')
    await fs.writeFile(path.join(prepared, 'preload.cjs'), originalPreload + '\n;(()=>{\n' + privateBridge + '\n})();\n')
  } finally { process.chdir(originalCwd) }
  for (const [entry, filename, format] of [['main.ts', 'main.mjs', 'es']]) {
    await build({ configFile: false, root: fixture, logLevel: 'error', ssr: { noExternal: true }, build: {
      ssr: path.join(fixture, entry), target: 'node22', outDir: prepared, emptyOutDir: false,
      rollupOptions: { external: ['electron', /^@agentmux\/core(?:\/|$)/], output: { format, entryFileNames: filename } } } })
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const name of Object.keys(env)) if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_')) delete env[name]
  Object.assign(env, { HOME: path.join(privateRoot, 'home'), XDG_CACHE_HOME: path.join(privateRoot, 'cache'), XDG_CONFIG_HOME: path.join(privateRoot, 'config'), XDG_DATA_HOME: path.join(privateRoot, 'data'), AGENTMUX_CHILD_UI_TOOL_HOME: process.env.HOME, AGENTMUX_CHILD_UI_CAPTURE_HOLD: process.env.AGENTMUX_CHILD_UI_CAPTURE_HOLD ?? '0', AGENTMUX_CHILD_UI_CAPTURE_PROVIDER: process.env.AGENTMUX_CHILD_UI_CAPTURE_PROVIDER === 'agentmux' ? 'agentmux' : process.env.AGENTMUX_CHILD_UI_CAPTURE_PROVIDER === 'orca' ? 'orca' : 'cua' })
  const launchServices = env.AGENTMUX_CHILD_UI_CAPTURE_PROVIDER === 'agentmux'
  const electronApp = launchServices ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(electron)?.[1] : null
  if (launchServices) assert.ok(process.platform === 'darwin' && electronApp && path.isAbsolute(electronApp), 'AgentMux native capture launches the exact macOS Electron.app path')
  const executable = launchServices ? '/usr/bin/open' : electron
  receipt.compiled = Object.fromEntries(await Promise.all(['preload.cjs', 'main.mjs'].map(async name => [name, hash(await fs.readFile(path.join(prepared, name)))])))
  for (const phase of scenario === 'survey-alias' ? ['survey'] : ['seed', 'restore']) {
    const stderr = []
    const bootstrap = path.join(privateRoot, 'bootstrap.cjs'), stageFile = path.join(output, phase + '-bootstrap.json')
    await fs.writeFile(bootstrap, `const fs=require('node:fs'),path=require('node:path'),{app}=require('electron');const root=${JSON.stringify(privateRoot)},stage=${JSON.stringify(stageFile)};const save=value=>fs.writeFileSync(stage,JSON.stringify({value,pid:process.pid,at:Date.now()}));save('bootstrap-start');for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>{save('app-ready');return import(${JSON.stringify(pathToFileURL(path.join(prepared, 'main.mjs')).href)})}).catch(error=>{save(String(error.stack||error));console.error(error);app.exit(1)});`)
    const nativeArgs = [bootstrap, prepared, privateRoot, output, phase, pageUrl, scenario]
    const nativeLogs = launchServices ? { stdout: `${phase}-native-stdout.log`, stderr: `${phase}-native-stderr.log` } : null
    const launchArgs = launchServices ? ['-n', '-W', '-a', electronApp, '--stdout', path.join(output, nativeLogs.stdout), '--stderr', path.join(output, nativeLogs.stderr),
      ...Object.entries(env).flatMap(([name, value]) => value !== undefined && (['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].includes(name) || name.startsWith('AGENTMUX_CHILD_UI_')) ? ['--env', `${name}=${value}`] : []), '--args', ...nativeArgs] : nativeArgs
    const exit = await runProbeProcess(executable, launchArgs, {
      temporaryRoot: privateRoot, cwd: privateRoot, env, timeoutMs: env.AGENTMUX_CHILD_UI_CAPTURE_HOLD === '1' ? 480000 : 90000, onLine: line => { stderr.push(line); process.stderr.write(phase + ': ' + line.slice(0, 1800) + '\n') } })
    await fs.writeFile(path.join(output, `${phase}-stderr.log`), stderr.join('\n'))
    const native = await fs.readFile(path.join(output, phase + '.json'), 'utf8').then(JSON.parse).catch(() => ({ passed: false, bootstrap: null }))
    native.bootstrap = await fs.readFile(stageFile, 'utf8').then(JSON.parse).catch(() => null)
    receipt.phases.push({ phase, exit, native, ...(launchServices ? { launch: { method: 'macos-launch-services', application: electronApp, wrapper: executable, nativeExecutable: electron, nativeLogs } } : {}) })
    receipt.images.push(...native.images ?? [])
    assert.equal(exit.timedOut, false, phase + ' watchdog')
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true, native.failure?.message)
  }
  if (scenario !== 'survey-alias') assert.equal(new Set(receipt.phases.map(one => one.native.pid)).size, 2, 'Two actual Electron processes')
  receipt.httpRequests = httpRequests
  receipt.sourceAfter = await hashes()
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Candidate product and fixture files remained unchanged during native verification')
  receipt.rendererInputsAfter = await fileHashes(Object.keys(rendererInputs).map(file => path.join(root, file)))
  assert.deepEqual(receipt.rendererInputsAfter, rendererInputs, 'All Renderer dependencies remain the original compiled candidate')
  for (const image of receipt.images) image.sha256 = hash(await fs.readFile(path.join(output, image.filename)))
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await new Promise(resolve => server.close(resolve))
  await stopProbeProcesses(process.pid + 1000000000, privateRoot)
  receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), privateRootRemoved: false }
  if (!receipt.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, output, images: receipt.images, captureOnly: true, aestheticReview: 'not-performed' }))
