import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'collapse-panel-owner': ['apps/desktop/src/renderer/src/components/MoteConnectionIdentity.tsx', 'key={JSON.stringify([props.target, props.hostingTarget])}', 'key={JSON.stringify(props.target)}'],
  'drop-preference-save-owner': ['apps/desktop/src/renderer/src/components/MoteConnectionIdentity.tsx', 'api.motePreferences.save(input, snapshot.hostingTarget)', 'api.motePreferences.save(input)'],
  'borrow-current-sync-owner': ['apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts', 'return newHostingTarget ? structuredClone(newHostingTarget) : await api.connections.hostingTarget()', 'return await api.connections.hostingTarget()'],
  'relabel-old-save-owner': ['apps/desktop/src/renderer/src/store.ts', "if (previous && JSON.stringify([previous.input, previous.hostingTarget]) !== JSON.stringify([parsed.input, parsed.hostingTarget])) throw new Error('The original Mote save input and hosting owner cannot be replaced.')", "if (previous && JSON.stringify(previous.input) !== JSON.stringify(parsed.input)) throw new Error('The original Mote save input and hosting owner cannot be replaced.')"]
} as const
const mutation = process.env.IDENTITY_HOSTING_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Mote prepared intent mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'identity-original-hosting-consumer', enforce: 'pre',
 resolveId(source, importer) {
  if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return require.resolve(source)
  if (source === '@agentmux/core') return resolve(root,'packages/core/src/index.ts')
  if (source === '@agentmux/connectors') return resolve(root,'packages/connectors/src/index.ts')
  if (source.startsWith('@agentmux/host/')) {
   const entry=JSON.parse(readFileSync(resolve(root,'apps/host/package.json'),'utf8')).exports['./'+source.slice('@agentmux/host/'.length)]?.import
   if(typeof entry==='string'&&entry.startsWith('./dist/')) return resolve(root,'apps/host/src',entry.slice(7).replace(/\.js$/u,'.ts'))
  }
  if (source.startsWith('@agentmux/core/')) {
   const entry=JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8')).exports['./'+source.slice('@agentmux/core/'.length)]?.import
   if(typeof entry==='string'&&entry.startsWith('./dist/')) return resolve(root,'packages/core/src',entry.slice(7).replace(/\.js$/u,'.ts'))
  }
  if (!importer || !source.startsWith('.')) return
  const dist=resolve(dirname(importer),source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
  if(dist)return resolve(root,'packages',dist[1]!,'src',dist[2]!+'.ts')
 },
 transform(original,id){
  const path=relative(root,id.split('?')[0]!)
  if(!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path))return
  let loaded=original;const selected=mutation&&variants[mutation]
  if(selected&&selected[0]===path){if(original.split(selected[1]).length!==2)throw Error('Mutation anchor not unique');loaded=original.replace(selected[1],selected[2])}
  if(!process.env.IDENTITY_HOSTING_LOADED)return loaded===original?undefined:loaded
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),marker={path,originalSHA256:hash(original),loadedSHA256:hash(loaded),...(loaded===original?{}:{mutation})}
  return {code:"import { appendFileSync as __motePreparedLoaded } from 'node:fs'; __motePreparedLoaded("+JSON.stringify(process.env.IDENTITY_HOSTING_LOADED)+', '+JSON.stringify(JSON.stringify(marker)+'\n')+');\n'+loaded,map:null}
 }
 }],test:{include:['apps/desktop/test/mote-identity-hosting.test.tsx'],fileParallelism:false,passWithNoTests:false,testTimeout:30000,hookTimeout:20000} })
