import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'share-room-metadata-owner': ['apps/desktop/src/renderer/src/lib/use-connector-room-name.ts', 'binding.externalConversationId, hostingTarget]', 'binding.externalConversationId]'],
  'drop-room-inspect-owner': ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', "'connection.room.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)", "'connection.room.inspect', { operationId: intent.input.operationId })"],
  'adopt-unqualified-room': ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'sameHosting(intent.hostingTarget, hostingTarget) && (', 'true && ('],
  'share-room-draft-owner': ['apps/desktop/src/renderer/src/lib/connector-room-intent.ts', '...(hostingTarget ? [hostingTarget.hostId, hostingTarget.runtimeId] : [])', '...[]']
} as const
const mutation = process.env.ROOM_HOSTING_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Mote prepared intent mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'room-original-hosting-consumer', enforce: 'pre',
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
  if(!process.env.ROOM_HOSTING_LOADED)return loaded===original?undefined:loaded
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),marker={path,originalSHA256:hash(original),loadedSHA256:hash(loaded),...(loaded===original?{}:{mutation})}
  return {code:"import { appendFileSync as __motePreparedLoaded } from 'node:fs'; __motePreparedLoaded("+JSON.stringify(process.env.ROOM_HOSTING_LOADED)+', '+JSON.stringify(JSON.stringify(marker)+'\n')+');\n'+loaded,map:null}
 }
 }],test:{include:['apps/desktop/test/connector-room-hosting.test.tsx'],fileParallelism:false,passWithNoTests:false,testTimeout:30000,hookTimeout:20000} })
