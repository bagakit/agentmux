import { browserSourceBuild } from '../../../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from '../../probe-process.mjs'
export const SETTINGS_NAVIGATION_PRODUCT_SOURCES = ['apps/desktop/src/renderer/src/App.tsx','apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/desktop-presentation.ts','apps/desktop/src/renderer/src/components/SettingsNavigation.tsx',
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx','apps/desktop/src/shared/desktop-focus-observation.ts']
export async function verifySettingsNavigationNative({root,fixture,evidence,privateRoot,receipt}) {
  const require=createRequire(path.join(root,'packages/core/package.json')),desktopRequire=createRequire(path.join(root,'apps/desktop/package.json'))
  const {build:buildNode}=browserSourceBuild(require('esbuild')),{build:buildRenderer}=await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const hash=value=>createHash('sha256').update(value).digest('hex')
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(manifest.exports).map(([key,value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '$'),
    replacement: path.join(root,'packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/,'.ts')) }))
  const clientUi = JSON.parse(await fs.readFile(path.join(root, 'packages/client-ui/package.json'),'utf8')).exports
  for (const [key,value] of Object.entries(clientUi).sort(([a],[b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length-a.length)) {
    const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2), target = typeof value === 'string' ? value : value.browser
    aliases.push({ find: new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('(.+)') + '$'),
      replacement: path.join(root,'packages/client-ui',target).replace('*','$1') })
  }
  aliases.push({ find: /^@agentmux\/layout$/, replacement: path.join(root,'packages/core/src/spatial-layout.ts') })
  const consumed = new Map()
  await buildRenderer({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    resolve: { alias: aliases }, plugins: [{ name: 'settings-product-consumer', enforce: 'pre', transform(source,id) {
      const file=id.split('?')[0]; if(file.startsWith(root+'/apps/desktop/src/') || file.startsWith(root+'/packages/core/src/')) consumed.set(path.relative(root,file),hash(source))
    } }], build: { outDir: path.join(privateRoot,'renderer'),emptyOutDir:true,minify:false,target:'esnext' } })
  for (const file of SETTINGS_NAVIGATION_PRODUCT_SOURCES.filter(file => file.includes('/renderer/'))) assert.ok(consumed.has(file),'Actual rendered product consumer: '+file)
  receipt.compiledSource=Object.fromEntries(consumed)
  const nodeAliases=Object.fromEntries(aliases.filter(value=>!value.find.source.includes('(')).map(value=>[value.find.source.slice(1,-1).replaceAll('\\/','/').replaceAll('\\.','.'),value.replacement]))
  const main=path.join(privateRoot,'main.cjs'), cli=path.join(privateRoot,'amux.mjs')
  await buildNode({entryPoints:[path.join(fixture,'main.mjs')],outfile:main,bundle:true,platform:'node',format:'cjs',external:['electron'],alias:nodeAliases,
    define:{'import.meta.url':JSON.stringify(pathToFileURL(path.join(root,'packages/core/src/spatial-state.ts')).href)},logLevel:'error'})
  await buildNode({entryPoints:[path.join(root,'packages/core/src/agentmux.ts')],outfile:cli,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'error'})
  receipt.artifacts = { main: hash(await fs.readFile(main)), cli: hash(await fs.readFile(cli)),
    renderer: Object.fromEntries(await Promise.all((await fs.readdir(path.join(privateRoot, 'renderer/assets'))).map(async file => [file, hash(await fs.readFile(path.join(privateRoot,'renderer/assets',file)))]))) }
  await fs.symlink(path.join(root,'packages/core/node_modules'),path.join(privateRoot,'node_modules'))
  await fs.mkdir(path.join(privateRoot,'workspace'))
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('AGENTMUX_')&&!name.startsWith('CTXMUX_')&&name!=='ELECTRON_RUN_AS_NODE'))
  const lines=[]
  receipt.nativeProcess=await runProbeProcess(desktopRequire('electron'),[main,path.join(privateRoot,'renderer/index.html'),privateRoot,path.join(fixture,'preload.cjs'),evidence,process.execPath,cli],
    {temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>{lines.push(line);process.stderr.write('settings-native: '+line.slice(0,700)+'\n')}})
  await fs.writeFile(path.join(evidence,'native.log'),lines.join('\n'))
  receipt.native=JSON.parse(await fs.readFile(path.join(evidence,'native.json'),'utf8'))
  assert.equal(receipt.nativeProcess.exitCode,0,JSON.stringify(receipt.native.failure));assert.equal(receipt.native.passed,true)
  assert.deepEqual(receipt.native.cleanupErrors,[])
}
