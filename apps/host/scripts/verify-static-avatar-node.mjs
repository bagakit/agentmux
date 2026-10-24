import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, cp, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { materializeStaticAvatarRuntime } from '../../desktop/scripts/static-avatar-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), host = join(root, 'apps/host')
const require = createRequire(join(host, 'package.json')), ts = require('typescript'), { transform } = require('esbuild')
const client = join(root, 'packages/client-ui'), source = join(client, 'src')
const temporary = await mkdtemp(join(root, '.cache/static-avatar-node-'))
const target = join(temporary, 'node_modules/@agentmux/client-ui')
const digest = value => createHash('sha256').update(value).digest('hex')
let report
try {
  await mkdir(target, { recursive: true })
  const manifest = await readFile(join(client, 'package.json'))
  await writeFile(join(target, 'package.json'), manifest)
  await symlink(join(client, 'node_modules'), join(target, 'node_modules'))
  const entries = ['lib/agent-avatar-svg.ts', 'lib/mote-avatar-svg.ts', 'lib/space-icon-ids.ts', 'theme/index.ts', 'components/AgentAvatarBadgeIcon.tsx']
  const program = ts.createProgram(entries.map(path => join(source, path)), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, esModuleInterop: true,
    rootDir: source, outDir: join(target, 'dist'), noEmitOnError: true, declaration: false, sourceMap: false })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'))
  assert.equal(program.emit().emitSkipped, false)
  const inputs = Object.fromEntries(await Promise.all(program.getSourceFiles().filter(file => file.fileName.startsWith(source) && !file.isDeclarationFile)
    .map(async file => [file.fileName.slice(root.length + 1), digest(await readFile(file.fileName))])))
  await cp(join(source, 'assets/agent-icons'), join(target, 'src/assets/agent-icons'), { recursive: true })
  const original = await readFile(join(host, 'src/static-avatar.ts'), 'utf8')
  await writeFile(join(temporary, 'static-avatar.mjs'), (await transform(original, { loader: 'ts', format: 'esm', target: 'node24' })).code)
  const packageRoot = name => dirname(require.resolve(name + '/package.json'))
  await mkdir(join(temporary, 'node_modules/@resvg'), { recursive: true })
  await symlink(packageRoot('@resvg/resvg-js'), join(temporary, 'node_modules/@resvg/resvg-js'))
  await symlink(join(root, 'packages/core'), join(temporary, 'node_modules/@agentmux/core'))
  const child = `
    import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
    const {savedAgentAvatarDrawing,savedMoteAvatarDrawing,rasterizeStaticAvatar}=await import(process.argv[2]??'./static-avatar.mjs');
    import {AgentAvatarStaticArtwork} from '@agentmux/client-ui/components/AgentAvatarStaticArtwork';
    assert.equal(typeof document,'undefined'); assert.equal(typeof window,'undefined'); assert.equal(typeof AgentAvatarStaticArtwork,'function');
    const rows=[]; const parent=new AbortController();
    for(const provider of ['codex','gemini','hermes','traex','grok','antigravity','cursor']){
      const first=savedAgentAvatarDrawing({appearance:{},executors:{exact:{providerId:provider,avatar:{tint:'#67b9ef',badge:'shield'}}}},provider,'exact');
      const image=await rasterizeStaticAvatar(first.svg,64,parent.signal);
      rows.push({provider,revision:first.revision,width:image.width,height:image.height,byteLength:image.byteLength,pngSHA256:createHash('sha256').update(Buffer.from(image.dataUrl.split(',')[1],'base64')).digest('hex')});
    }
    const mote=await rasterizeStaticAvatar(savedMoteAvatarDrawing(null,{}),256,parent.signal);
    console.log(JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch,desktopLoaded:false,sharedImport:true,rows,mote:{width:mote.width,height:mote.height,byteLength:mote.byteLength},sameParentSignal:!parent.signal.aborted}));`
  await writeFile(join(temporary, 'consume.mjs'), child)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(temporary, 'consume.mjs')], { maxBuffer: 1024 * 1024 })
  assert.equal(stderr, '')
  const result = JSON.parse(stdout); assert.equal(result.rows.length, 7); assert.equal(result.sameParentSignal, true)
  const desktop = join(root, 'apps/desktop'), desktopRequire = createRequire(join(desktop, 'package.json'))
  const { resolveConfig } = await import(pathToFileURL(desktopRequire.resolve('electron-vite')).href)
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const { config } = await resolveConfig({ configFile: join(desktop, 'electron.vite.config.ts'), root: desktop, logLevel: 'silent' }, 'build', 'production')
  const main = config.main, published = JSON.parse(manifest).exports
  const aliases = Object.entries(published).sort(([left], [right]) => right.length - left.length).flatMap(([key, value]) => {
    if (typeof value?.import !== 'string' || !value.import.startsWith('./dist/')) return []
    const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
    return [{ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: resolve(target, value.import).replace('*', '$1') }]
  })
  main.resolve = { ...main.resolve, alias: [...aliases, ...Object.entries(main.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement }))] }
  const app = join(temporary, 'main-package'), output = join(app, 'out/main')
  main.build = { ...main.build, outDir: output, emptyOutDir: true, sourcemap: false,
    rollupOptions: { ...main.build.rollupOptions, input: join(host, 'src/static-avatar.ts'), output: { format: 'es', entryFileNames: 'consumer.mjs' } } }
  main.configFile = false; main.logLevel = 'silent'
  const built = await build(main), chunks = (Array.isArray(built) ? built : [built]).flatMap(value => value.output ?? [])
  assert(chunks.some(chunk => chunk.type === 'chunk' && chunk.imports.includes('@resvg/resvg-js')), 'The actual Main config must retain the native renderer as an external')
  await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }))
  const { packages: nativePackages, assets } = await materializeStaticAvatarRuntime(root, app)
  assert.equal(nativePackages.length, 2, 'Only the JS renderer and installed platform native package are copied')
  const license = await readFile(join(dirname(createRequire(join(app, 'package.json')).resolve('@resvg/resvg-js/package.json')), 'LICENSE'))
  assert.equal(digest(license), digest(await readFile(join(packageRoot('@resvg/resvg-js'), 'LICENSE'))))
  assert.match(license.toString(), /Mozilla Public License Version 2\.0/u)
  for (const [file, hash] of Object.entries(assets)) assert.equal(hash, digest(await readFile(join(source, 'assets/agent-icons', file))))
  assert.deepEqual(Object.keys(assets).sort(), ['antigravity.png', 'cursor.png', 'gemini.png', 'grok.png', 'hermes.png', 'traex.png'])
  assert.equal(digest(await readFile(join(app, 'node_modules/@agentmux/client-ui/package.json'))), digest(manifest))
  for (const name of ['react', 'react-dom']) await symlink(join(client, 'node_modules', name), join(app, 'node_modules', name))
  const mainChild = await promisify(execFile)(process.execPath, [join(temporary, 'consume.mjs'), pathToFileURL(join(output, 'consumer.mjs')).href], { maxBuffer: 1024 * 1024 })
  assert.equal(mainChild.stderr, '')
  const mainResult = JSON.parse(mainChild.stdout)
  assert.deepEqual(mainResult.rows, result.rows, 'Bundling must retain the exact same artwork and PNGs')
  const renderer = config.renderer, browserOutput = join(temporary, 'renderer')
  const browserEntry = join(temporary, 'browser-entry.ts')
  await writeFile(browserEntry, `import { AgentProviderArtwork } from ${JSON.stringify(join(source, 'components/AgentProviderIcon.tsx'))};
    export const portraits=Object.fromEntries(['gemini','hermes','traex','grok','antigravity','cursor'].map(providerId=>[providerId,AgentProviderArtwork({providerId,size:24}).props.src]));`)
  // Retain the real Renderer React/asset pipeline; unrelated whole-view PDF/diagram emitters have no consumer in this leaf.
  renderer.plugins = renderer.plugins.flat(Infinity).filter(plugin => !['agentmux-pdfjs-viewer-assets', 'agentmux-file-diagram-assets'].includes(plugin?.name))
  renderer.base = './'; renderer.configFile = false; renderer.logLevel = 'silent'
  renderer.build = { ...renderer.build, outDir: browserOutput, emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false,
    rollupOptions: { input: browserEntry, output: { format: 'es', entryFileNames: 'consumer.mjs' }, preserveEntrySignatures: 'strict' } }
  await build(renderer)
  const { portraits } = await import(pathToFileURL(join(browserOutput, 'consumer.mjs')).href)
  const browserAssets = {}
  for (const [provider, url] of Object.entries(portraits)) {
    const bytes = await readFile(fileURLToPath(url))
    assert.equal(digest(bytes), assets[provider + '.png'], 'The original Renderer must publish each selected original PNG')
    browserAssets[provider] = { pngSHA256: digest(bytes), byteLength: bytes.length }
  }
  assert.equal(Object.keys(browserAssets).length, 6)
  inputs['apps/host/src/static-avatar.ts'] = digest(original)
  inputs['packages/client-ui/package.json'] = digest(manifest)
  inputs['THIRD_PARTY_NOTICES.md'] = digest(await readFile(join(root, 'THIRD_PARTY_NOTICES.md')))
  for (const [file, hash] of Object.entries(assets)) inputs['packages/client-ui/src/assets/agent-icons/' + file] = hash
  for (const path of ['apps/desktop/electron.vite.config.ts', 'apps/desktop/scripts/static-avatar-runtime.mjs', 'apps/desktop/scripts/package-macos.mjs']) inputs[path] = digest(await readFile(join(root, path)))
  report = { scope: 'Bounded original TypeScript emit, real Node package imports, actual Main-config native closure and original Renderer asset pipeline leaves. Unchanged external dependencies are linked; no full App package.', inputs, result, mainResult, nativePackages, assets, browserAssets, licenseSHA256: digest(license), temporaryRemoved: true }
} finally { await rm(temporary, { recursive: true, force: true }) }
console.log(JSON.stringify(report))
