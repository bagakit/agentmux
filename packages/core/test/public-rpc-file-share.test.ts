import { expect, it } from 'vitest'
import { fixturePath } from './helpers/fixture-values.js'
import { fileUploadRevision, type FileReadResource, type FileWriteParams, type FileWriteResult } from '../src/public-rpc-files'
import { fileShareCreateOperation, fileShareSourceOperation, parseFileShareParams, parseFileShareResult, type FileShareParams, type FileShareResult } from '../src/public-rpc-file-share'
import { boundedFileShareResult } from '../src/public-rpc-service'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES, rpcEncode } from '../src/public-rpc-frame'
const digest = (body: string) => fileUploadRevision(new TextEncoder().encode(body))
const body = (noteId: string, text = 'Ordinary Markdown') => `---\nschema: agentmux.note.md.v1\nnote-id: ${noteId}\n---\n\n${text}\n`
function fixture() {
  const root = fixturePath('shared-notes'), base: FileReadResource = { hostId: 'local', workspaceId: 'notes', workspacePath: root, zoneId: 'zone', zonePath: root, path: 'source.note.md' }
  const request = (path: string, noteId: string, operationId: string): FileWriteParams => ({ zoneId: 'zone', path, expectedResource: { ...base, path }, content: body(noteId), baseContent: body(noteId), expectedRevision: digest(body(noteId)), operationId })
  const source = request('source.note.md', 'source', 'source-draft'), destination = request('destination.note.md', 'destination', 'destination-save')
  const params: FileShareParams = { operationId: 'batch-original', destination, promotions: [{ operationId: 'promotion-original', source, sourceNoteId: 'source', sourceBlockId: 'source-block', referenceId: 'occurrence', shared: { zoneId: 'zone', path: 'shared.note.md', expectedResource: { ...base, path: 'shared.note.md' }, noteId: 'shared' } }] }
  const written = (resource: FileReadResource, content: string, eventId: string): FileWriteResult => ({ resource, result: { status: 'written', content, revision: digest(content), noteHistory: { status: 'committed', eventId, batchId: eventId } } })
  const result: FileShareResult = { operationId: params.operationId, status: 'committed', promotions: [{ operationId: params.promotions[0]!.operationId,
    shared: written(params.promotions[0]!.shared.expectedResource, body('shared'), fileShareCreateOperation(params.promotions[0]!)), source: written(source.expectedResource, body('source'), fileShareSourceOperation(params, source)) }], destination: written(destination.expectedResource, body('destination'), destination.operationId!) }
  return { params, result, written }
}
it('pins all original save resources, baseline bytes and operation identities through the typed public boundary', () => {
  const { params, result } = fixture()
  expect(parseFileShareParams(params)).toBe(params); expect(parseFileShareResult(result, params)).toBe(result)
  const wrongOperation = structuredClone(result); wrongOperation.operationId = 'another-batch'; expect(() => parseFileShareResult(wrongOperation, params)).toThrow()
  const wrongTarget = structuredClone(result); wrongTarget.promotions[0]!.shared!.resource!.path = 'foreign.note.md'; expect(() => parseFileShareResult(wrongTarget, params)).toThrow()
  const missingPhase = structuredClone(result); missingPhase.promotions[0]!.source = null; expect(() => parseFileShareResult(missingPhase, params)).toThrow('each original resource receipt')
  const unknownHistory = structuredClone(result); if (unknownHistory.destination!.result.status !== 'written') throw Error('Expected written fixture')
  unknownHistory.destination!.result.noteHistory!.status = 'unconfirmed'; expect(() => parseFileShareResult(unknownHistory, params)).toThrow('each original resource receipt')
  const duplicate = structuredClone(params); duplicate.promotions.push({ ...duplicate.promotions[0]!, operationId: 'second-promotion' }); expect(() => parseFileShareParams(duplicate)).toThrow('one shared Markdown entity')
  const stale = structuredClone(params); stale.promotions[0]!.source.baseContent += 'changed'; expect(() => parseFileShareParams(stale)).toThrow('exact base content')
})
it('keeps all committed per-file outcomes when combined canonical bodies and observations exceed the actual RPC frame', () => {
  const { params, result, written } = fixture(), text = 'x'.repeat(12 * 1024 * 1024)
  const resources = [params.promotions[0]!.shared.expectedResource, params.promotions[0]!.source.expectedResource, params.destination.expectedResource] as const
  const notes = ['shared', 'source', 'destination'] as const
  const receipts = resources.map((resource, index) => written(resource, body(notes[index]!, text), index === 0 ? fileShareCreateOperation(params.promotions[0]!) : index === 1 ? fileShareSourceOperation(params, params.promotions[0]!.source) : params.destination.operationId!))
  result.promotions[0]!.shared = receipts[0]!; result.promotions[0]!.source = receipts[1]!; result.destination = receipts[2]!
  const observed = (receipt: FileWriteResult) => { if (receipt.result.status !== 'written') throw Error('Expected saved fixture'); return { resource: receipt.resource, result: { status: 'read' as const, document: { path: receipt.resource!.path, content: receipt.result.content!, revision: receipt.result.revision } } } }
  result.promotions[0]!.currentShared = observed(receipts[0]!); result.promotions[0]!.currentSource = observed(receipts[1]!); result.currentDestination = observed(receipts[2]!)
  expect(() => rpcEncode({ jsonrpc: '2.0', id: 1, result })).toThrow('frame budget')
  const compact = boundedFileShareResult(result, 1)
  expect(() => rpcEncode({ jsonrpc: '2.0', id: 1, result: compact })).not.toThrow()
  expect(parseFileShareResult(compact, params)).toMatchObject({ status: 'committed', promotions: [{ shared: { result: { status: 'written', contentUnavailable: expect.any(String), noteHistory: { status: 'committed', eventId: 'promotion-original:create' } } }, currentShared: { result: { status: 'unknown', code: 'NOTE_SHARE_CONTENT_SEPARATE' } } }] })
  expect(compact.destination!.resource).toEqual(result.destination!.resource)
  if (compact.destination!.result.status !== 'written' || result.destination!.result.status !== 'written') throw Error('Expected committed write')
  expect(compact.destination!.result.revision).toBe(result.destination!.result.revision)
}, 20_000)

it('compacts nested undo bodies against the entire combined inspection frame even when standalone undo fits',()=>{
 const {params,result,written}=fixture();params.undoReferenceIds=['old-use'];const source=written(params.destination.expectedResource,body('destination'),params.destination.operationId!)
 result.undo={operationId:params.destination.operationId!,status:'committed',destination:source,collections:[{noteId:'old-shared',referenceIds:['old-use'],resource:null,source:null,deletion:null,retainedReason:{code:'other-references',message:'Another use remains.'}}]}
 if(source.result.status!=='written')throw Error('fixture');source.result.content=''
 const overhead=new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,result:result.undo})).length
 source.result.content='x'.repeat(AGENTMUX_RPC_MAX_MESSAGE_BYTES-overhead-64)
 expect(()=>rpcEncode({jsonrpc:'2.0',id:1,result:result.undo})).not.toThrow()
 expect(()=>rpcEncode({jsonrpc:'2.0',id:1,result:{mode:'request',result}})).toThrow('frame budget')
 const compact=boundedFileShareResult(result,1,true)
 expect(compact.undo!.destination!.result).toMatchObject({status:'written',contentUnavailable:expect.any(String),noteHistory:{status:'committed'}})
 expect(()=>rpcEncode({jsonrpc:'2.0',id:1,result:{mode:'request',result:compact}})).not.toThrow()
 expect(parseFileShareResult(compact,params).status).toBe('committed')
},20_000)
it('requires the complete undo receipt for a committed combined save and accurate partial receipts for known partial',()=>{
 const {params,result,written}=fixture();params.undoReferenceIds=['old-use'];expect(()=>parseFileShareResult(result,params)).toThrow('complete original undo')
 result.undo={operationId:params.destination.operationId!,status:'unknown',destination:result.destination,collections:[]};expect(()=>parseFileShareResult(result,params)).toThrow()
 result.status='partial';expect(()=>parseFileShareResult(result,params)).toThrow()
 result.undo={operationId:params.destination.operationId!,status:'partial',destination:result.destination,collections:[{noteId:'old-shared',referenceIds:['old-use'],resource:null,source:written(params.destination.expectedResource,body('destination'),params.destination.operationId!),deletion:null,retainedReason:{code:'scope-changed',message:'Original source restored but shared retained.'}}]}
 expect(parseFileShareResult(result,params).status).toBe('partial')
})
