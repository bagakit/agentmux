import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), desktop = join(root, 'apps/desktop'), fixture = import.meta.dirname
const require = createRequire(join(desktop, 'package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')).href)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = resolve(process.env.AGENTMUX_PRESENTATION_RESOURCE_EVIDENCE || join(root, '.tmp', 'browser-presentation-product-native-' + Date.now()))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.browser-presentation-product-native.v1', evidence, passed: false,
  T004Qualified: false, userAppRunRuntimeControls: 0, inputs: {},
  boundary: 'Actual App/Store/Workbench and original BrowserPane own all product stages. Original Main/preload/BVM and authorized same-stream capture are real; maintained typed non-Browser data is isolated. Explicit media-only evidence does not qualify first press, IME, clipboard, Run, restart or installation.' }
const mediaOnly=process.argv.includes('--media-only')
receipt.firstPressRequested=!mediaOnly
const inputs = new Map(), logs = []
let privateRoot
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr)
  receipt.freshness = { exitCode: freshness.status, rebuilt: false }
  assert.equal(freshness.status, 0, 'Unmodified production Core/Demand freshness guard')
  receipt.main = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  privateRoot = await mkdtemp(join(tmpdir(), 'amux-native-resource-'))
  const out = join(privateRoot, 'out'); await mkdir(out)
  await symlink(join(desktop, 'node_modules'), join(privateRoot, 'node_modules'))
  const plugin = { name: 'literal-production-source-binding', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path); inputs.set(path, digest(bytes))
      let code = bytes.toString()
      if (path === join(desktop, 'src/renderer/src/lib/api.ts')) {
        const needle = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
        assert.equal(code.split(needle).length, 2)
        code = code.replace(needle, 'export const api = mockApi')
        receipt.typedNonBrowserFactory = { path: relative(root,path), originalSHA256: digest(bytes), compiledSHA256: digest(code), browserAndMedia: 'Original production preload Browser API replaces only the maintained typed data factory Browser namespace.' }
      }
      return { contents: code, loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
  const main = join(out, 'main.mjs'), preload = join(out, 'preload.cjs'), entry = join(out, 'entry.js')
  const settings = { bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], plugins: [plugin], metafile: true, logLevel: 'silent' }
  const mainBuild = await build({ ...settings, format: 'esm', entryPoints: [join(fixture, 'product-main.ts')], outfile: main,
    banner: { js: "import {createRequire as createNativeRequire} from 'node:module';const require=createNativeRequire(import.meta.url);" } })
  // Sandboxed preload bundles local pure dependencies; only Electron is a native external.
  const preloadBuild = await build({ ...settings, packages: 'bundle', entryPoints: [join(desktop, 'src/preload/index.ts')], outfile: preload })
  const rendererPlugin = { name: 'literal-product-App-renderer', enforce: 'pre', transform(code,id) {
    const file=id.split('?')[0]
    if (!file.startsWith(root+'/') || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(file)) return
    inputs.set(file,digest(code))
    if (file===join(desktop,'src/renderer/src/lib/api.ts')) {
      const needle='export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
      assert.equal(code.split(needle).length,2);const changed=code.replace(needle,'export const api = mockApi')
      receipt.typedNonBrowserFactory={path:relative(root,file),originalSHA256:digest(code),compiledSHA256:digest(changed),browserAndMedia:'The exact production preload Browser namespace replaces only the maintained non-Browser typed data fixture.'}
      return{code:changed,map:null}
    }
  } }
  const cssPlugin={postcssPlugin:'literal-product-App-css',OnceExit(css){css.walk(node=>{const input=node.source?.input;if(input?.file?.startsWith(root+'/apps/desktop/'))inputs.set(input.file,digest(input.css))})}}
  const reuse = process.argv.find(argument => argument.startsWith('--reuse-renderer='))?.slice('--reuse-renderer='.length)
  if (reuse) {
    const previous = JSON.parse(await readFile(join(resolve(root,reuse),'receipt.json'),'utf8'))
    const reusedSources = Object.entries(previous.inputs).filter(([file]) => file.startsWith('apps/desktop/src/renderer/') || file.startsWith('packages/layout/') || file.endsWith('/product-entry.mjs') || file.endsWith('/product-index.html'))
    assert.ok(reusedSources.length > 100,'Reused actual App Renderer inputs are nonempty')
    for (const [file, sha] of reusedSources) { const full=join(root,file);assert.equal(digest(await readFile(full)),sha,'Exact immutable Renderer reuse '+file);inputs.set(full,sha) }
    const copy = async (from,to) => { await mkdir(to,{recursive:true});for (const entry of await readdir(from,{withFileTypes:true})) {
      if (['main.mjs','preload.cjs','source.html'].includes(entry.name))continue
      if(entry.isDirectory())await copy(join(from,entry.name),join(to,entry.name));else await copyFile(join(from,entry.name),join(to,entry.name))
    } }
    await copy(join(resolve(root,reuse),'compiled'),out)
    receipt.rendererReuse={evidence:reuse,sourceCount:reusedSources.length,actualSourceExact:true}
  } else {
  await viteBuild({configFile:false,root:fixture,base:'./',logLevel:'error',plugins:[rendererPlugin],css:{postcss:{plugins:[cssPlugin]}},
    define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},build:{outDir:out,emptyOutDir:false,target:'esnext',rollupOptions:{input:join(fixture,'product-index.html')}}})
  }
  const entryBuild = {metafile: 'Actual Vite product Renderer; original Source and CSS captured by pre transform/PostCSS AST.'}
  const sourcePage = join(out, 'source.html'), html = join(out, 'product-index.html')
  await writeFile(sourcePage, `<!doctype html><html><body style="margin:0;min-height:100vh"><button id="original-button" style="margin:32px;width:160px;height:64px">Original action</button><input id="original-input"><output id="frame-counter"></output><script>
const count=Number(sessionStorage.loads||0)+1;sessionStorage.loads=count;
window.sourceFacts={loads:count,frames:0,presses:[],clicks:0};
setInterval(()=>{const f=++sourceFacts.frames;document.body.style.background=f%2?'rgb(238,45,64)':'rgb(25,190,75)';document.querySelector('#frame-counter').textContent=f},100);
document.querySelector('#original-button').addEventListener('click',e=>{sourceFacts.clicks++;sourceFacts.lastClickTrusted=e.isTrusted;e.target.textContent='Action '+sourceFacts.clicks});
for(const type of ['mousedown','mouseup'])document.addEventListener(type,e=>sourceFacts.presses.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,button:e.button,target:e.target.id}));
</script></body></html>`)

  await mkdir(join(evidence, 'compiled'))
  receipt.compiled = {}
  const allFiles=async directory=>(await Promise.all((await (await import('node:fs/promises')).readdir(directory,{withFileTypes:true})).map(item=>item.isDirectory()?allFiles(join(directory,item.name)):[join(directory,item.name)]))).flat()
  for (const output of await allFiles(out)) {
    const file=relative(out,output)
    await mkdir(join(evidence,'compiled',path.dirname(file)),{recursive:true})
    const bytes = await readFile(join(out, file)); receipt.compiled[file] = { sha256: digest(bytes), bytes: bytes.length }
    await copyFile(join(out, file), join(evidence, 'compiled', file))
  }
  for (const file of ['product-proof.mjs','product-index.html','vitest.resource.config.mts','tsconfig.resource.json']) {
    const path = join(fixture, file); inputs.set(path, digest(await readFile(path)))
  }
  const packageEntries = []
  for (const name of ['core', 'demand']) {
    const directory = join(root, 'packages', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    assert.equal(typeof manifest.exports['.'].import, 'string', 'Actual public ESM export')
    packageEntries.push(resolve(directory, manifest.exports['.'].import))
  }
  for (const file of ['pnpm-lock.yaml','packages/core/package.json','packages/demand/package.json',...packageEntries]) {
    const path = resolve(root, file); inputs.set(path, digest(await readFile(path)))
  }
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  await writeFile(join(evidence, 'metafiles.json'), JSON.stringify({ main: mainBuild.metafile, preload: preloadBuild.metafile, entry: entryBuild.metafile }, null, 2) + '\n')
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson'),
    AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json') }
  delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [main, html, privateRoot, preload, evidence, sourcePage, ...(mediaOnly?['--media-only']:[])],
    { cwd: root, temporaryRoot: privateRoot, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.native = JSON.parse(await readFile(join(evidence, 'native-receipt.json'), 'utf8'))
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs].map(async ([path]) => [relative(root, path), digest(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Actual Source/compiled dependency inputs before/after')
  assert.equal(receipt.process.exitCode, 0, 'Original private product fixture exit')
  assert.equal(receipt.native.passed, true, 'Actual product facts')
  assert.equal(receipt.native.openProduct.stages.length, 2, 'Actual App product stages are nonempty')
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs].map(async ([path]) => [relative(root, path), digest(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Actual Source/compiled dependency inputs before/after')
  receipt.frames = await Promise.all(receipt.native.frames.map(async frame => {
    const bytes = await readFile(join(evidence, frame.file)); return { ...frame, sha256: digest(bytes), bytes: bytes.length }
  }))
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n') + '\n')
  if (privateRoot) {
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { privateRoot, remaining, removed: false, borrowedLinksChanged: false }
    if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ evidence: relative(root, evidence), productPassed: receipt.passed,
    phases: receipt.native?.phases.length, failure: receipt.failure?.message, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
