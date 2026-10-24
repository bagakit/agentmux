import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { productInputs } from './fixtures/focus-composable-filters/inputs.mjs'

const root=resolve(import.meta.dirname,'../../..'), config=resolve(root,'apps/desktop/test/tsconfig.focus-composable-filters.json')
const baselineRevision='3ffd501a6370775451529f5260ae7f5a23fc8cda'
const changed=[
  'apps/desktop/src/renderer/src/components/FocusFilters.tsx','apps/desktop/src/renderer/src/lib/focus-filters.ts',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/lib/focus-lane-origin.ts',
  'apps/desktop/src/renderer/src/lib/focus-context.ts','apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx',
  'apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx',
  'apps/desktop/src/renderer/src/components/FocusHistorySearch.tsx','apps/desktop/src/renderer/src/components/FocusSearchLocations.tsx',
  'apps/desktop/test/focus-narrow-filters.test.tsx','apps/desktop/test/focus-composable-filters.test.tsx',
  'apps/desktop/test/focus-source-filter-membership.test.ts','apps/desktop/test/focus-history-search.test.tsx',
  'apps/desktop/test/focus-coordination-projection.test.tsx','apps/desktop/test/focus-context-cost.test.ts'
]
assert.ok(changed.filter(file=>file.startsWith('apps/desktop/src/')).every(file=>productInputs.includes(file)), 'Owned typechecked sources are bound by the affected product manifest')
const parsed=ts.getParsedCommandLineOfConfigFile(config,{noEmit:true},{...ts.sys,onUnRecoverableConfigFileDiagnostic:d=>{throw Error(ts.flattenDiagnosticMessageText(d.messageText,'\n'))}})
assert.ok(parsed&&!parsed.errors.length)
const virtual=new Map(),newFiles=new Set()
const baselineFiles=new Set(execFileSync('git',['ls-tree','-r','--name-only',baselineRevision,'--',...changed],{cwd:root,encoding:'utf8'}).trim().split('\n'))
for(const file of changed){
  if(baselineFiles.has(file))virtual.set(resolve(root,file),execFileSync('git',['show',baselineRevision+':'+file],{cwd:root,encoding:'utf8'}))
  else newFiles.add(resolve(root,file))
}
function inspect(baseline){
  const host=ts.createCompilerHost(parsed.options),read=host.readFile
  if(baseline)host.readFile=file=>virtual.has(resolve(file))?virtual.get(resolve(file)):read(file)
  const ownedRoots=[...new Set([...parsed.fileNames,...changed.map(file=>resolve(root,file))])]
  const roots=baseline?ownedRoots.filter(file=>!newFiles.has(resolve(file))):ownedRoots
  const program=ts.createProgram(roots,parsed.options,host)
  return ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?relative(root,d.file.fileName):null,code:d.code,start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))
}
const current=inspect(false)
let baseline=[]
if(current.length)baseline=inspect(true)
const known=new Set(baseline.map(d=>JSON.stringify(d))),introduced=current.filter(d=>!known.has(JSON.stringify(d)))
const evidence=resolve(root,'.local/state/focus-composable-filters/source');mkdirSync(evidence,{recursive:true})
const hash=value=>createHash('sha256').update(value).digest('hex')
const inputs=changed.map(file=>({file,currentSHA256:hash(readFileSync(resolve(root,file))),baselineSHA256:baselineFiles.has(file)?hash(virtual.get(resolve(root,file))):null}))
const inputManifestSHA256=hash(readFileSync(resolve(root,'apps/desktop/scripts/fixtures/focus-composable-filters/inputs.mjs')))
writeFileSync(resolve(evidence,'types.json'),JSON.stringify({fullPass:current.length===0,baselineRevision,inputManifestSHA256,inputs,scope:'Current owned source/test diagnostics compared with the fixed prechange revision; unmodified dependencies use current sources, without disk mutation',baseline,current,introduced},null,2)+'\n')
assert.deepEqual(introduced,[],'No introduced type errors; inherited diagnostics remain recorded separately')
console.log(JSON.stringify({scopedPass:true,fullPass:current.length===0,baselineRevision,inheritedDiagnosticCount:current.length,evidence:'.local/state/focus-composable-filters/source/types.json'}))
