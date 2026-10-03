import { fixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult, type FileReadParams, type FileReadResult } from '../src/public-rpc-files'
const params:FileReadParams={zoneId:'original-zone',path:'saved.txt',expectedResource:{hostId:'local',workspaceId:'workspace',workspacePath:fixturePath("workspace")}}
function receipt(logicalDirectory?:string):FileReadResult{return{resource:{...params.expectedResource,zoneId:params.zoneId,zonePath:logicalDirectory===undefined?fixturePath("workspace/inside"):fixturePath("confirmed/physical"),path:(logicalDirectory===undefined?'inside':logicalDirectory)+(logicalDirectory===''?'':'/')+'saved.txt',...(logicalDirectory===undefined?{}:{logicalDirectory})},result:{status:'read',document:{path:(logicalDirectory===undefined?'inside':logicalDirectory)+(logicalDirectory===''?'':'/')+'saved.txt',content:'Original bytes',revision:'sha256:'+'a'.repeat(64)}}}}
it.each([undefined,'original/namespace',''])('original physical or explicit logical namespace has exact resource/document mapping: %s',logical=>{const value=receipt(logical);expect(()=>parseFileReadResult(value,params)).not.toThrow();expect(parseFileReadResult(value,params)).toBe(value);const list={resource:value.resource,result:{status:'listed',files:['child.txt'],complete:true,omitted:'none',partialReason:null}};expect(parseFileListResult(list,params)).toBe(list)})
it.each([fixturePath("absolute"),("C:" + (fixturePath("absolute"))),'a\\b','a//b','a/','./a','a/../b','a\nname','a\0name'])('a declared namespace never admits escaped or noncanonical logical directory: %s',logical=>{expect(()=>parseFileReadResult(receipt(logical),params)).toThrow(/logical directory|identity or path/)})
it('an undeclared outside physical directory retains the original containment refusal',()=>{const value=receipt();value.resource!.zonePath=fixturePath("foreign/physical");expect(()=>parseFileReadResult(value,params)).toThrow('outside its original Workspace')})
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
import { parseFileWriteParams, parseFileWriteResult } from '../src/public-rpc-files'
const writeParams = { ...params, expectedResource: receipt().resource!, content: '原正文\n😀', expectedRevision: 'sha256:' + 'a'.repeat(64) }
it('keeps original write outcomes and resource mapping, never promotes unknown to written', () => {
  expect(parseFileWriteParams(writeParams)).toEqual(writeParams)
  const resource = receipt().resource
  for (const result of [{ status: 'written', revision: 'sha256:' + 'b'.repeat(64) }, { status: 'conflict', observedRevision: null }, { status: 'unknown', code: 'WRITE_UNKNOWN', message: 'Keep draft' }, { status: 'error', code: 'WRITE_ERROR', message: 'Original failure' }]) {
    expect(parseFileWriteResult({ resource, result }, writeParams)).toEqual({ resource, result })
  }
  expect(parseFileWriteResult({ resource: null, result: { status: 'unknown', code: 'UNAVAILABLE', message: 'Original reference retained' } }, writeParams)).toMatchObject({ resource: null, result: { status: 'unknown' } })
  expect(() => parseFileWriteResult({ resource: { ...resource, zonePath: fixturePath("workspace/other"), path: 'other/saved.txt' }, result: { status: 'written', revision: writeParams.expectedRevision } }, writeParams)).toThrow('mapping changed')
  expect(() => parseFileWriteParams({ ...writeParams, expectedRevision: null })).toThrow()
  expect(() => parseFileWriteParams({ ...writeParams, content: 3 })).toThrow()
  expect(() => parseFileWriteResult({ resource: null, result: { status: 'written', revision: writeParams.expectedRevision } }, writeParams)).toThrow()
  expect(() => parseFileWriteResult({ resource: { ...resource, workspaceId: 'foreign' }, result: { status: 'written', revision: writeParams.expectedRevision } }, writeParams)).toThrow()
})

it('retains multi-line and long original write diagnostics with their actual unknown status', () => {
  const message = 'Original failure\n' + '中文😀'.repeat(20000)
  for (const resource of [null, receipt().resource]) expect(parseFileWriteResult({ resource, result: { status: 'unknown', code: 'ORIGINAL_UNKNOWN', message } }, writeParams).result).toEqual({ status: 'unknown', code: 'ORIGINAL_UNKNOWN', message })
})
