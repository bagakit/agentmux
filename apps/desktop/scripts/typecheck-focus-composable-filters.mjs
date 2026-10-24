import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'

const root=resolve(import.meta.dirname,'../../..'), config=resolve(root,'apps/desktop/test/tsconfig.focus-composable-filters.json')
const changed=[
  'apps/desktop/src/renderer/src/components/FocusFilters.tsx','apps/desktop/src/renderer/src/lib/focus-filters.ts',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/lib/focus-lane-origin.ts',
  'apps/desktop/src/renderer/src/components/FocusHistorySearch.tsx','apps/desktop/src/renderer/src/components/FocusSearchLocations.tsx',
  'apps/desktop/test/focus-narrow-filters.test.tsx','apps/desktop/test/focus-composable-filters.test.tsx',
  'apps/desktop/test/focus-source-filter-membership.test.ts','apps/desktop/test/focus-history-search.test.tsx'
]
const parsed=ts.getParsedCommandLineOfConfigFile(config,{noEmit:true},{...ts.sys,onUnRecoverableConfigFileDiagnostic:d=>{throw Error(ts.flattenDiagnosticMessageText(d.messageText,'\n'))}})
assert.ok(parsed&&!parsed.errors.length)
const virtual=new Map(),newFiles=new Set()
for(const file of changed){try{virtual.set(resolve(root,file),execFileSync('git',['show','HEAD:'+file],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}))}catch{newFiles.add(resolve(root,file))}}
function inspect(baseline){
  const host=ts.createCompilerHost(parsed.options),read=host.readFile
  if(baseline)host.readFile=file=>virtual.has(resolve(file))?virtual.get(resolve(file)):read(file)
  const roots=baseline?parsed.fileNames.filter(file=>!newFiles.has(resolve(file))):parsed.fileNames
  const program=ts.createProgram(roots,parsed.options,host)
  return ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?relative(root,d.file.fileName):null,code:d.code,start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))
}
const current=inspect(false)
let baseline=[]
if(current.length)baseline=inspect(true)
const known=new Set(baseline.map(d=>JSON.stringify(d))),introduced=current.filter(d=>!known.has(JSON.stringify(d)))
const evidence=resolve(root,'.local/state/focus-composable-filters/source');mkdirSync(evidence,{recursive:true})
writeFileSync(resolve(evidence,'types.json'),JSON.stringify({fullPass:current.length===0,scope:'Current owned source/test diagnostics compared with virtual HEAD versions, without disk mutation',baseline,current,introduced},null,2)+'\n')
assert.deepEqual(introduced,[],'No introduced type errors; inherited diagnostics remain recorded separately')
console.log(JSON.stringify({scopedPass:true,fullPass:current.length===0,inheritedDiagnosticCount:current.length,evidence:'.local/state/focus-composable-filters/source/types.json'}))
