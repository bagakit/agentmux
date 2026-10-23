import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'drop-retirement-lifetime': ['apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts', '          if (token !== lifetime.current || order !== occurrences.current.get(id)) return\n          accept(operation)', '          accept(operation)'],
  'discard-intent-correlation': ['apps/desktop/src/renderer/src/store.ts', "  if (request.action === 'create') parseMoteConnectionResult('space.mote.connection.create', operation, request.input)\n  else parseMoteConnectionResult('space.mote.connection.sync', operation, request.input)", '  // The original admission correlation was removed.'],
  'borrow-current-image': ['apps/desktop/src/renderer/src/components/MoteBotSetup.tsx', 'connectionProfileAvatarDigest(candidateImage) === operation?.snapshot.avatarSha256', 'true'],
  'omit-target-recheck': ['packages/connectors/src/mote-connection-operations.ts', '// Requalify only this original target after asynchronous admission reads.\n    await this.ports.assertTarget(input.source.target)', '// The original target recheck was removed.'],
  'discard-historical-unknown': ['apps/desktop/src/renderer/src/lib/mote-bot-request.ts', "if (input.operationId === key) result[key] = { action: row.action, input, phase, inspectOnly: true } as MoteBotRequest", 'if (false) result[key] = { action: row.action, input, phase, inspectOnly: true } as MoteBotRequest'],
  'ignore-prepared-profile': ['packages/connectors/src/mote-connection-operations.ts', 'name: input.desired.name, description: input.desired.description,', "name: 'Substitute name', description: 'Substitute description',"],
  'ignore-prepared-png': ['packages/connectors/src/mote-connection-operations.ts', 'pngDataUrl: input.desired.avatar?.pngDataUrl ?? null,', 'pngDataUrl: null,'],
  'replace-frozen-child': ['packages/connectors/src/mote-connection-operations.ts', "const input = parseConnectionEnrollmentParams('connection.enrollment.begin', row.enrollmentInput)", "const input = parseConnectionEnrollmentParams('connection.enrollment.begin', { ...row.enrollmentInput, preset: { ...row.enrollmentInput.preset, name: 'Rebuilt child' } })"]
} as const
const mutation = process.env.MOTE_PREPARED_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Mote prepared intent mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'prepared-mote-source-consumer', enforce: 'pre',
 resolveId(source, importer) {
  if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return require.resolve(source)
  if (source === '@agentmux/core') return resolve(root,'packages/core/src/index.ts')
  if (source === '@agentmux/connectors') return resolve(root,'packages/connectors/src/index.ts')
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
  if(!process.env.MOTE_PREPARED_LOADED)return loaded===original?undefined:loaded
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),marker={path,originalSHA256:hash(original),loadedSHA256:hash(loaded),...(loaded===original?{}:{mutation})}
  return {code:"import { appendFileSync as __motePreparedLoaded } from 'node:fs'; __motePreparedLoaded("+JSON.stringify(process.env.MOTE_PREPARED_LOADED)+', '+JSON.stringify(JSON.stringify(marker)+'\n')+');\n'+loaded,map:null}
 }
 }],test:{include:['apps/desktop/test/mote-prepared-intent.test.tsx'],fileParallelism:false,passWithNoTests:false,testTimeout:30000,hookTimeout:20000} })
