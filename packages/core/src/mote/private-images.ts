import { AgentMuxError } from '../errors.js'
import { FILE_UPLOAD_MAX_BYTES, fileUploadRevision, parseFileUploadIdentity, type FileUploadIdentity } from '../public-rpc-files.js'
import { rpcRecord } from '../rpc-data.js'

export type MotePrivateImageRead = { threadId: string; messageId: string; imageOperationId: string }
export type MotePrivateImage = { operationId: string; name: string; mimeType: string; revision: string; byteLength: number }
export type MotePrivateImageResult = MotePrivateImageRead & { image: MotePrivateImage; dataBase64: string }

type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'
function invalid(code: Code): never { throw new AgentMuxError('The original private image or its message reference is invalid.', code) }
const imageMime = /^image\/(?:png|jpeg|jpg|gif|webp|heic|heif)$/u

export function parsePrivateImageUploads(value: unknown, code: Code): FileUploadIdentity[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) return invalid(code)
  const uploads = Array.from(value, image => parseFileUploadIdentity(image, code))
  if (uploads.some(image => !imageMime.test(image.mimeType)) || new Set(uploads.map(image => image.operationId)).size !== uploads.length)
    return invalid(code)
  return uploads
}

export function parseMotePrivateImageRead(value: unknown): MotePrivateImageRead {
  const code = 'INVALID_CONTROL_REQUEST', fields = ['threadId', 'messageId', 'imageOperationId'] as const
  const record = rpcRecord(value, fields, code)
  for (const key of fields) if (typeof record[key] !== 'string' || !record[key].trim() || record[key].length > 512 || /[\0\r\n]/u.test(record[key])) return invalid(code)
  return record as MotePrivateImageRead
}

export function privateImageMetadata({ operationId, name, mimeType, revision, byteLength }: FileUploadIdentity): MotePrivateImage {
  return { operationId, name, mimeType, revision, byteLength }
}

export function parsePrivateImageMetadata(value: unknown): MotePrivateImage {
  const code = 'CONTROL_PROTOCOL_ERROR', image = rpcRecord(value, ['operationId', 'name', 'mimeType', 'revision', 'byteLength'], code)
  if (typeof image.operationId !== 'string' || !image.operationId || typeof image.name !== 'string' || !image.name || /[\\/\0]/u.test(image.name) ||
    typeof image.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(image.revision) || typeof image.mimeType !== 'string' || !imageMime.test(image.mimeType) ||
    !Number.isSafeInteger(image.byteLength) || Number(image.byteLength) < 1 || Number(image.byteLength) > FILE_UPLOAD_MAX_BYTES) return invalid(code)
  return image as MotePrivateImage
}

export function parseMotePrivateImageResult(value: unknown, expected: MotePrivateImageRead): MotePrivateImageResult {
  const code = 'CONTROL_PROTOCOL_ERROR', result = rpcRecord(value, ['threadId', 'messageId', 'imageOperationId', 'image', 'dataBase64'], code)
  if (result.threadId !== expected.threadId || result.messageId !== expected.messageId || result.imageOperationId !== expected.imageOperationId) return invalid(code)
  const image = parsePrivateImageMetadata(result.image)
  if (image.operationId !== expected.imageOperationId || typeof result.dataBase64 !== 'string' || result.dataBase64.length > 4 * Math.ceil(image.byteLength / 3)) return invalid(code)
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(result.dataBase64), char => char.charCodeAt(0)) }
  catch { return invalid(code) }
  if (bytes.length !== image.byteLength || fileUploadRevision(bytes) !== image.revision) return invalid(code)
  return result as unknown as MotePrivateImageResult
}
