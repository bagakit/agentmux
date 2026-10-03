import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult, type FileReadParams, type FileReadResult } from '../src/public-rpc-files'
const params:FileReadParams={zoneId:'original-zone',path:'saved.txt',expectedResource:{hostId:'local',workspaceId:'workspace',workspacePath:upstreamFixturePath("workspace")}}
function receipt(logicalDirectory?:string):FileReadResult{return{resource:{...params.expectedResource,zoneId:params.zoneId,zonePath:logicalDirectory===undefined?upstreamFixturePath("workspace/inside"):upstreamFixturePath("confirmed/physical"),path:(logicalDirectory===undefined?'inside':logicalDirectory)+(logicalDirectory===''?'':'/')+'saved.txt',...(logicalDirectory===undefined?{}:{logicalDirectory})},result:{status:'read',document:{path:(logicalDirectory===undefined?'inside':logicalDirectory)+(logicalDirectory===''?'':'/')+'saved.txt',content:'Original bytes',revision:'sha256:'+'a'.repeat(64)}}}}
it.each([undefined,'original/namespace',''])('original physical or explicit logical namespace has exact resource/document mapping: %s',logical=>{const value=receipt(logical);expect(()=>parseFileReadResult(value,params)).not.toThrow();expect(parseFileReadResult(value,params)).toBe(value);const list={resource:value.resource,result:{status:'listed',files:['child.txt'],complete:true,omitted:'none',partialReason:null}};expect(parseFileListResult(list,params)).toBe(list)})
it.each([upstreamFixturePath("absolute"),("C:" + (upstreamFixturePath("absolute"))),'a\\b','a//b','a/','./a','a/../b','a\nname','a\0name'])('a declared namespace never admits escaped or noncanonical logical directory: %s',logical=>{expect(()=>parseFileReadResult(receipt(logical),params)).toThrow(/logical directory|identity or path/)})
it('an undeclared outside physical directory retains the original containment refusal',()=>{const value=receipt();value.resource!.zonePath=upstreamFixturePath("foreign/physical");expect(()=>parseFileReadResult(value,params)).toThrow('outside its original Workspace')})
it('explicit namespace preserves all original tuple/path/document/revision guards',()=>{const value=receipt('logical');for(const key of ['hostId','workspaceId','workspacePath','zoneId'] as const)expect(()=>parseFileReadResult({...value,resource:{...value.resource!,[key]:'foreign'}},params)).toThrow('Another File resource');expect(()=>parseFileReadResult({...value,resource:{...value.resource!,path:'foreign/saved.txt'}},params)).toThrow('Another File path');if(value.result.status!=='read')throw Error('Fixture must read');const document=value.result.document;expect(()=>parseFileReadResult({...value,result:{...value.result,document:{...document,path:'foreign/saved.txt'}}},params)).toThrow('Another File document');expect(()=>parseFileReadResult({...value,result:{...value.result,document:{...document,revision:'display-version'}}},params)).toThrow('complete original File revision')})
it('uses one optional whole-file byte cap while preserving ordinary reads and names-only list requests',()=>{
  expect(parseFileReadParams(params)).toEqual(params)
  expect(parseFileReadParams({...params,maxBytes:131072}).maxBytes).toBe(131072)
  for(const maxBytes of [0,-1,1.5,16777217,'131072',NaN])expect(()=>parseFileReadParams({...params,maxBytes})).toThrowError(expect.objectContaining({code:'INVALID_CONTROL_REQUEST'}))
  expect(()=>parseFileListParams({...params,maxBytes:131072})).toThrow()
  const value=receipt();if(value.result.status!=='read')throw Error('Fixture must read')
  value.result.document.content='中'.repeat(10)
  expect(()=>parseFileReadResult(value,{...params,maxBytes:30})).not.toThrow()
  expect(()=>parseFileReadResult(value,{...params,maxBytes:29})).toThrowError(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
  expect(()=>parseFileReadResult(value,params)).not.toThrow()
})
