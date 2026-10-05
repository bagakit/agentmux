import { expect, it } from 'vitest'
import { ToolkitFailureCapture, parseToolkitPerformanceFailureDetails, parseToolkitPerformanceFailure, toolkitFailureError } from '../src/toolkit-performance-failure.js'
import { parseToolkitRequest, parseToolkitSnapshot } from '../src/toolkit.js'
import { parseToolkitCommand } from '../src/toolkit-cli.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { deepMetricsSnapshot } from './helpers/toolkit-metrics.js'
const details = () => ({ stage: 'toolkit-json' as const, error: toolkitFailureError(new SyntaxError('original syntax failure')), bytes: null, exit: null })
it('retains non-overlapping byte ranges across chunks without retaining input storage', () => {
  const raw = Buffer.alloc(25000); for (let i=0;i<raw.length;i++) raw[i]=i%251
  const capture = new ToolkitFailureCapture('toolkit-output', 100)
  for (let n=0;n<raw.length;n+=333) capture.append(raw.subarray(n,n+333))
  const expectedPrefix = Buffer.from(raw.subarray(0,4096)), expectedSuffix = Buffer.from(raw.subarray(-4096))
  raw.fill(0)
  expect(capture.value).toEqual({ source:'toolkit-output',startByte:100,endByte:25100,prefixBase64:expectedPrefix.toString('base64'),suffixBase64:expectedSuffix.toString('base64'),omittedBytes:16808 })
  expect(parseToolkitPerformanceFailureDetails({ ...details(), bytes:capture.value }).bytes).toEqual(capture.value)
})
it.each([0,1,4096,4097,8192])('preserves complete %i-byte coverage without overlap', size => {
  const capture=new ToolkitFailureCapture('metrics-rpc-stdout',12), raw=Buffer.alloc(size,65);capture.append(raw)
  const bytes=capture.value
  expect(Buffer.concat([Buffer.from(bytes.prefixBase64,'base64'),Buffer.from(bytes.suffixBase64,'base64')])).toEqual(raw)
  expect(bytes.omittedBytes).toBe(0);expect(bytes.endByte-bytes.startByte).toBe(size)
})
it('rejects false coverage, unknown stages and impure evidence without getters', () => {
  const capture=new ToolkitFailureCapture('toolkit-output',0);capture.append(Buffer.alloc(9000,65))
  expect(()=>parseToolkitPerformanceFailureDetails({...details(),bytes:{...capture.value,omittedBytes:0}})).toThrow()
  expect(()=>parseToolkitPerformanceFailureDetails({...details(),stage:'some-parser'})).toThrow()
  let reads=0;const impure:any=details();Object.defineProperty(impure.error,'stack',{get(){reads++;return ''},enumerable:true})
  expect(()=>parseToolkitPerformanceFailureDetails(impure)).toThrow();expect(reads).toBe(0)
})
it('bounds error UTF8 bytes and explicitly reports clipped text', () => {
  const error=new Error('主'.repeat(5000));error.stack='主'.repeat(5000)
  const primary=toolkitFailureError(error,true)
  expect(Buffer.byteLength(primary.message)).toBeLessThanOrEqual(4096)
  expect(Buffer.byteLength(primary.stack!)).toBeLessThanOrEqual(8192)
  expect(primary).toMatchObject({messageTruncated:true,stackTruncated:true})
  expect(()=>parseToolkitPerformanceFailureDetails({...details(),error:primary})).not.toThrow()
})
it('uses exact Toolkit public option and CLI flag only for Performance watch', async () => {
  expect(await parseToolkitCommand(['watch','performance','--capture-failure'])).toEqual({method:'toolkit.watch',params:{toolId:'performance',captureFailure:true}})
  await expect(parseToolkitCommand(['watch','phone','--capture-failure'])).rejects.toThrow()
  const base={schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'request',operation:'toolkit.watch',toolId:'performance'}
  expect(parseToolkitRequest({...base,captureFailure:true})).toMatchObject({captureFailure:true})
  expect(()=>parseToolkitRequest({...base,captureFailure:false})).toThrow()
  expect(()=>parseToolkitRequest({...base,toolId:'phone',captureFailure:true})).toThrow()
  expect(()=>parseToolkitRequest({...base,operation:'toolkit.get',captureFailure:true})).toThrow()
})
it('retains the failure original identity after current Run cleanup through typed snapshot', () => {
  const snapshot=deepMetricsSnapshot()
  const failure=parseToolkitPerformanceFailure({schema:'agentmux.performance.failure.v1',executionId:'prior-execution',run:{hostId:'local',runId:'original-run'},recordedAt:1000,details:details()})
  snapshot.run=null;snapshot.diagnostics={captureEnabled:false,failureEvidence:'included',droppedWrites:0,lastFailure:failure,persistence:'confirmed',issue:null,cleanupIssue:null}
  expect(parseToolkitSnapshot(snapshot)).toEqual(snapshot)
  expect((parseToolkitSnapshot(snapshot) as typeof snapshot).diagnostics.lastFailure?.run?.runId).toBe('original-run')
})

it('admits the largest legal escaped error and fragments within the derived file budget',()=>{
 const capture=new ToolkitFailureCapture('metrics-rpc-stdout',0);capture.append(Buffer.alloc(20000,65))
 const failure={schema:'agentmux.performance.failure.v1',executionId:'execution',run:{hostId:'local',runId:'run'},recordedAt:1000,details:{
  stage:'cli-eof',error:{message:'\x01'.repeat(4096),stack:'\x01'.repeat(8192),code:'\x01'.repeat(128),messageTruncated:false,stackTruncated:false},bytes:capture.value,exit:{code:1,signal:'\x01'.repeat(128)}}}
 const terminal=new ToolkitFailureCapture('toolkit-terminal',0),stderr=new ToolkitFailureCapture('metrics-rpc-stderr',0);terminal.append(Buffer.alloc(20000,65));stderr.append(Buffer.alloc(20000,66))
 Object.assign(failure.details,{diagnosticOutput:[terminal.value,stderr.value]})
 expect(Buffer.byteLength(JSON.stringify(failure))).toBeGreaterThan(96*1024)
 expect(()=>parseToolkitPerformanceFailure(failure)).not.toThrow()
})

it('requires independent capture and raw-read opt-ins through CLI and typed requests',async()=>{
 expect(await parseToolkitCommand(['inspect','performance','--failure-evidence'])).toEqual({method:'toolkit.inspect',params:{toolId:'performance',includeFailureEvidence:true}})
 expect(await parseToolkitCommand(['watch','performance','--capture-failure','--failure-evidence'])).toEqual({method:'toolkit.watch',params:{toolId:'performance',captureFailure:true,includeFailureEvidence:true}})
 const base={schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'request',operation:'toolkit.get',toolId:'performance'}
 expect(parseToolkitRequest({...base,includeFailureEvidence:true})).toMatchObject({includeFailureEvidence:true})
 expect(()=>parseToolkitRequest({...base,toolId:'phone',includeFailureEvidence:true})).toThrow()
 expect(()=>parseToolkitRequest({...base,operation:'toolkit.script',includeFailureEvidence:true})).toThrow()
 await expect(parseToolkitCommand(['inspect','performance','--capture-failure'])).rejects.toThrow()
 await expect(parseToolkitCommand(['watch','performance','--failure-evidence','--failure-evidence'])).rejects.toThrow()
})
it('ordinary failure metadata neither reads nor retains an Error stack',()=>{
 const error=new Error('original');let reads=0;Object.defineProperty(error,'stack',{get(){reads++;return 'private raw stack'}})
 expect(toolkitFailureError(error)).toMatchObject({stack:null,stackTruncated:false});expect(reads).toBe(0)
})
