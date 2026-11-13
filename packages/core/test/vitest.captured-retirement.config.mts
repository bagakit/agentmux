import base from './vitest.hook-transaction.config.mts'
import {defineConfig}from'vitest/config'
import{appendFileSync,readFileSync}from'node:fs'
import{resolve,relative}from'node:path'
import{createHash}from'node:crypto'
import{execFileSync}from'node:child_process'
const root=resolve(import.meta.dirname,'../../..'),oldCommit='d6a0101168bd12b6a4b8187710e71efbb09f62a1'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const mutation=process.env.CAPTURED_G_MUTATION?JSON.parse(readFileSync(process.env.CAPTURED_G_MUTATION,'utf8'))as{name:string;file:string;before:string;after:string}:undefined
export default defineConfig({...base,cacheDir:resolve(root,'.cache/captured-retirement'),plugins:[{
 name:'captured-retirement-original-source',enforce:'pre',load(id){
  if(!id.endsWith('?pre-g'))return
  const file=relative(root,id.split('?')[0]!)
  if(!['packages/core/src/agent-session-store.ts','packages/core/src/captured-history.ts'].includes(file))throw Error('Unqualified old owner request')
  const original=execFileSync('git',['show',oldCommit+':'+file],{cwd:root,encoding:'utf8'})
  let source=original
  if(file.endsWith('/agent-session-store.ts')){
    const before="from './captured-history.js'"
    if(source.split(before).length!==2)throw Error('Original Store history owner binding changed')
    source=source.replace(before,"from './captured-history.js?pre-g'")
  }
  const report=process.env.CAPTURED_G_LOADED
  if(report)appendFileSync(report,JSON.stringify({path:file,selectedCommit:oldCommit,originalSHA256:hash(original),loadedSHA256:hash(source),bindingOnlyRewrite:source!==original})+'\n')
  return source
 },transform(original,id){
  if(id.includes('?pre-g'))return
  const file=relative(root,id.split('?')[0]!)
  if(!file.startsWith('packages/')&&!file.startsWith('apps/'))return
  let source=original
  if(mutation?.file===file){if(source.split(mutation.before).length!==2)throw Error('Mutation must identify exactly one owner: '+mutation.name);source=source.replace(mutation.before,mutation.after)}
  const report=process.env.CAPTURED_G_LOADED
  if(report)appendFileSync(report,JSON.stringify({path:file,originalSHA256:hash(original),loadedSHA256:hash(source),...(source===original?{}:{mutation:mutation?.name})})+'\n')
  return source===original?undefined:{code:source,map:null}
 }}],test:{...base.test,include:process.env.CAPTURED_G_INCLUDE?JSON.parse(process.env.CAPTURED_G_INCLUDE):['packages/core/test/captured-retirement-store.test.ts','packages/core/test/captured-retirement-public.test.ts','packages/core/test/captured-retirement-cost.test.ts','packages/core/test/captured-session-read-isolation.test.ts','packages/core/test/conversation-window-captured-versions.test.ts'],testNamePattern:process.env.CAPTURED_G_PATTERN||undefined,passWithNoTests:false,testTimeout:30000}})
