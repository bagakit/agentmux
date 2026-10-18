import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { FILE_UPLOAD_MAX_BYTES, parseFileCreateParams, parseFileCreateResult, type FileCreateParams, type FileReadResource } from './public-rpc-files.js'

// Reuse the existing Files transfer budget: bytes expand to base64 in RPC and
// again in encrypted Relay framing, below its 8 MiB physical buffer budget.
export { FILE_UPLOAD_MAX_BYTES as FILE_IMPORT_MAX_BYTES } from './public-rpc-files.js'
export type FileImportParams = Omit<FileCreateParams, 'content'> & {
  operationId: string; byteLength: number; revision: string; dataBase64: string
}
export type FileImportResult = { operationId: string; resource: FileReadResource | null; result:
  | { status: 'written'; revision: string; byteLength: number }
  | { status: 'conflict'; observedRevision: string | null }
  | { status: 'error' | 'unknown'; code: string; message: string }
}
const fail = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code) }

/** Exact absent destination; no Session identity, implicit directory or overwrite. */
export function parseFileImportParams(value: unknown): FileImportParams {
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'expectedRevision', 'operationId', 'byteLength', 'revision', 'dataBase64'], 'INVALID_CONTROL_REQUEST')
  const { operationId, byteLength, revision, dataBase64, ...target } = p
  parseFileCreateParams({ ...target, content: '' })
  if (typeof operationId !== 'string' || !operationId.length || operationId.length > 256 || /[\0\r\n]/u.test(operationId)) fail('Keep one original import operation ID.')
  if (/\.note\.(?:md|json)$/iu.test(p.path as string)) fail('Create Note content through the original text file writer so its identity and attribution are retained.')
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 0 || Number(byteLength) > FILE_UPLOAD_MAX_BYTES) fail('File import exceeds the existing 4 MiB Files transfer budget.')
  if (typeof revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(revision)) fail('The original bytes require their SHA-256 revision.')
  const padding = (3 - Number(byteLength) % 3) % 3
  if (typeof dataBase64 !== 'string' || dataBase64.length !== Math.ceil(Number(byteLength) / 3) * 4 ||
      /[^A-Za-z0-9+/=]/u.test(dataBase64) ||
      (padding ? dataBase64.indexOf('=') !== dataBase64.length - padding || !dataBase64.endsWith('='.repeat(padding)) : dataBase64.includes('=')))
    fail('The complete bounded import bytes are required.')
  return p as FileImportParams
}

export function parseFileImportResult(value: unknown, params: FileImportParams): FileImportResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) fail('Another file import operation was returned.', code)
  const result = rpcRecord(p.result, undefined, code)
  const fields = result.status === 'written' ? ['status', 'revision', 'byteLength'] : result.status === 'conflict'
    ? ['status', 'observedRevision'] : ['error', 'unknown'].includes(String(result.status)) ? ['status', 'code', 'message'] : null
  if (!fields) return fail('The original file import result is unconfirmed.', code)
  rpcRecord(result, fields, code)
  if (result.status === 'written' && (result.revision !== params.revision || result.byteLength !== params.byteLength)) fail('The imported bytes differ from the original request.', code)
  const { byteLength: _bytes, ...receipt } = result
  const { operationId: _operation, byteLength: _size, revision: _revision, dataBase64: _body, ...target } = params
  parseFileCreateResult({ resource: p.resource, result: receipt }, { ...target, content: '' })
  return p as FileImportResult
}
