import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
 'forget-resource': ['apps/host/src/file-resource.ts', "if (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) throw new AgentMuxError('The original File mapping changed. Read that exact file before deciding another save.', 'FILE_RESOURCE_MISMATCH')", "if (false) throw new AgentMuxError('The original File mapping changed. Read that exact file before deciding another save.', 'FILE_RESOURCE_MISMATCH')"],
 'substitute-current-revision': ['apps/host/src/ordinary-files.ts', 'expectedRevision: input.expectedRevision,', "expectedRevision: ((await this.read(workspace, input.path)) as Extract<FileDocumentReadResult, {status:'read'}>).document.revision,"],
 'lose-exclusive-create': ['apps/host/src/ordinary-files.ts', '...(input.expectedRevision === null ? { exclusive: true } : {})', '...{}'],
 'confirm-lost-ack': ['apps/host/src/ordinary-files.ts', "? { ...detail, status: 'unknown' } : detail", "? { status: 'written', revision: revisionFor(typeof input.content === 'string' ? Buffer.from(input.content) : input.content) } : detail"]
} as const
const mutation = process.env.ORDINARY_FILES_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown ordinary File source mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'original-ordinary-file-source', enforce: 'pre',
 resolveId(source, importer) {
  if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return require.resolve(source)
  for (const pkg of ['host', 'core', 'connectors']) {
   if(source === '@agentmux/' + pkg) return resolve(root, 'packages', pkg, 'src/index.ts')
   if(source.startsWith('@agentmux/' + pkg + '/')) {
    const name = source.slice(('@agentmux/' + pkg + '/').length)
    if(pkg === 'host') return resolve(root, 'apps/host/src', name + '.ts')
    const entry=JSON.parse(readFileSync(resolve(root,'packages',pkg,'package.json'),'utf8')).exports['./'+name]?.import
    if(typeof entry==='string' && entry.startsWith('./dist/')) return resolve(root,'packages',pkg,'src',entry.slice(7).replace(/\.js$/u,'.ts'))
   }
  }
  if (!importer || !source.startsWith('.')) return
  const dist=resolve(dirname(importer),source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
  if(dist)return resolve(root,'packages',dist[1]!,'src',dist[2]!+'.ts')
 },
 transform(source,id) {
  const path=relative(root,id.split('?')[0]!)
  if(!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path))return
  const selected=mutation&&variants[mutation]; let loaded=source
  if(selected && selected[0]===path) { if(source.split(selected[1]).length!==2)throw Error('Original ordinary File mutation anchor is not unique'); loaded=source.replace(selected[1],selected[2]) }
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
  if(process.env.ORDINARY_FILES_LOADED) {
   const marker={path,originalSHA256:hash(source),loadedSHA256:hash(loaded),...(loaded===source?{}:{mutation})}
   return {code:"import { appendFileSync as __ordinaryFileLoaded } from 'node:fs'; __ordinaryFileLoaded("+JSON.stringify(process.env.ORDINARY_FILES_LOADED)+', '+JSON.stringify(JSON.stringify(marker)+'\n')+');\n'+loaded,map:null}
  }
  if(loaded!==source)return loaded
 }
 }], test: { include: ['apps/desktop/test/ordinary-file-owner.test.ts','apps/desktop/test/workspace-files.test.ts','apps/desktop/test/mote-connection-preferences-public-consumer.test.ts','apps/desktop/test/public-file-create.test.ts'],
 fileParallelism:false, passWithNoTests:false, testTimeout:20000, hookTimeout:15000 } })
