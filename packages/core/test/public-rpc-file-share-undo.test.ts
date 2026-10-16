import { expect, it } from 'vitest'
import { fixturePath } from './helpers/fixture-values.js'
import { fileUploadRevision, type FileReadResource, type FileWriteResult } from '../src/public-rpc-files'
import { fileShareUndoStageOperation, parseFileShareUndoParams, parseFileShareUndoResult, type FileShareUndoParams, type FileShareUndoResult } from '../src/public-rpc-file-share'
const digest = (text: string) => fileUploadRevision(new TextEncoder().encode(text))
function fixture() {
  const root = fixturePath('shared-undo'), content = '---\nschema: agentmux.note.md.v1\nnote-id: destination\n---\n\nOrdinary draft input remains.\n'
  const resource: FileReadResource = { hostId: 'local', workspaceId: 'notes', workspacePath: root, zoneId: 'zone', zonePath: root, path: 'destination.note.md' }
  const params: FileShareUndoParams = { destination: { zoneId: 'zone', path: resource.path, expectedResource: resource, content, baseContent: content, expectedRevision: digest(content), operationId: 'undo-operation' }, referenceIds: ['saved-occurrence'] }
  const written: FileWriteResult = { resource, result: { status: 'written', content, revision: digest(content), noteHistory: { status: 'committed', eventId: 'undo-operation', batchId: 'undo-operation' } } }
  const shared = { ...resource, path: 'shared.note.md' }, eventId = fileShareUndoStageOperation('undo-operation', 'delete', 'shared-note')
  const result: FileShareUndoResult = { operationId: 'undo-operation', status: 'committed', destination: written, collections: [{ noteId: 'shared-note', referenceIds: ['saved-occurrence'], resource: shared, source: written, deletion: { resource: shared, result: { status: 'deleted', noteHistory: { status: 'committed', eventId, batchId: eventId } } } }] }
  return { params, result }
}
it('strictly consumes exact draft undo selection and each original collection receipt', () => {
  const { params, result } = fixture()
  expect(parseFileShareUndoParams(params)).toEqual(params)
  expect(parseFileShareUndoResult(result, params)).toEqual(result)
  expect(() => parseFileShareUndoParams({ ...params, referenceIds: [] })).toThrow()
  expect(() => parseFileShareUndoParams({ ...params, noOtherReferences: true })).toThrow()
})
it.each(['empty', 'missing-reference', 'duplicate-reference', 'arbitrary-resource', 'bare-history', 'wrong-delete-operation', 'missing-source', 'wrong-destination-operation'] as const)('rejects %s rather than certifying an empty or unrelated deletion', mutant => {
  const { params, result } = fixture(), item = result.collections[0]!
  if (mutant === 'empty') result.collections = []
  if (mutant === 'missing-reference') item.referenceIds = ['different-occurrence']
  if (mutant === 'duplicate-reference') item.referenceIds.push('saved-occurrence')
  if (mutant === 'arbitrary-resource') item.resource = item.deletion!.resource = { arbitrary: true } as never
  if (mutant === 'bare-history') item.deletion!.result.noteHistory = { status: 'committed' } as never
  if (mutant === 'wrong-delete-operation') item.deletion!.result.noteHistory = { status: 'committed', eventId: 'another-delete', batchId: 'another-delete' }
  if (mutant === 'missing-source') item.source = null
  if (mutant === 'wrong-destination-operation' && result.destination!.result.status === 'written') result.destination!.result.noteHistory = { status: 'committed', eventId: 'another-write', batchId: 'another-write' }
  expect(() => parseFileShareUndoResult(result, params)).toThrow()
})
it('preserves safe pre-preparation conflicts and original unconfirmed deletion diagnostics', () => {
  const { params, result } = fixture(), item = result.collections[0]!
  result.status = 'unknown'; item.deletion!.result = { status: 'conflict', code: 'CHANGED', message: 'The exact shared file changed before deletion preparation.' }
  expect(parseFileShareUndoResult(result, params)).toEqual(result)
  item.deletion!.result = { status: 'unknown', retainedPath: '.agentmux-reclaim-original.note.md', noteHistory: { status: 'unconfirmed', eventId: fileShareUndoStageOperation(params.destination.operationId!, 'delete', item.noteId), reason: 'The original preparation result is unknown.' } }
  expect(parseFileShareUndoResult(result, params)).toEqual(result)
})

it.each(['null-destination','unknown-source','unknown-delete','empty-coverage','missing-source-receipt','unconfirmed-delete-history'] as const)('rejects unsafe known partial %s facts',mutant=>{
 const {params,result}=fixture(),item=result.collections[0]!;result.status='partial';item.deletion=null;item.retainedReason={code:'scope-changed',message:'A known later dependency retained the shared file.'}
 expect(parseFileShareUndoResult(result,params)).toBe(result)
 if(mutant==='null-destination')result.destination=null
 if(mutant==='unknown-source')item.source={resource:item.source!.resource,result:{status:'unknown',code:'UNKNOWN',message:'unconfirmed'}}
 if(mutant==='unknown-delete')item.deletion={resource:item.resource!,result:{status:'unknown',noteHistory:{status:'prepared',eventId:fileShareUndoStageOperation(params.destination.operationId!,'delete',item.noteId),batchId:'original'}}}
 if(mutant==='unconfirmed-delete-history')item.deletion={resource:item.resource!,result:{status:'error',code:'LOST_RECEIPT',noteHistory:{status:'prepared',eventId:fileShareUndoStageOperation(params.destination.operationId!,'delete',item.noteId),batchId:'original'}}}
 if(mutant==='empty-coverage')result.collections=[]
 if(mutant==='missing-source-receipt')item.source=null
 expect(()=>parseFileShareUndoResult(result,params)).toThrow()
})
