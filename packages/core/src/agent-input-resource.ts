import { imageBytes } from './session-history-resource.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { FILE_UPLOAD_MAX_BYTES, fileUploadRevision, parseFileUploadIdentity, parseFileUploadResult, type FileUploadIdentity, type FileUploadResult } from './public-rpc-files.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'

/** A selected original upload and its exact span in the public user body, never a path grant. */
export type AgentInputImageReference = {
  start: number
  end: number
  bodyRevision: string
  upload: FileUploadIdentity
}
/** Frozen with the original Input. Availability is a resource observation, not an input gate. */
export type AgentInputImage = AgentInputImageReference & {
  observation: 'confirmed' | 'unavailable'
}
export type AgentInputResourceRead = { key: AgentPromptInputKey; index: number; revision: string; maxBytes: number }
export type AgentInputResourceResult = {
  key: AgentPromptInputKey
  index: number
  revision: string
} & ({ status: 'available'; mimeType: Extract<import('./types.js').AgentSessionHistoryResourceReadResult['result'], { status: 'read' }>['mimeType']; name: string; dataBase64: string; byteLength: number; width: number; height: number }
  | { status: 'unavailable'; code: string; message: string })

/** Host-owned immutable upload bytes; this interface has no caller-selected filesystem address. */
export type AgentInputResourceOwner = {
  inspect(identity: FileUploadIdentity): Promise<FileUploadResult>
  read(identity: FileUploadIdentity, maxBytes: number): Promise<{ dataBase64: string; byteLength: number; mimeType: string; revision: string } | null>
}
const invalid = (message = 'The original input image reference is invalid.'): never => {
  throw new AgentMuxError(message, 'INVALID_AGENT_INPUT_RESOURCE')
}
export function parseAgentInputImageReference(value: unknown): AgentInputImageReference {
  const p = rpcRecord(value, ['start', 'end', 'bodyRevision', 'upload'], 'INVALID_AGENT_INPUT_RESOURCE')
  if (!Number.isSafeInteger(p.start) || Number(p.start) < 0 || !Number.isSafeInteger(p.end) || Number(p.end) <= Number(p.start) ||
    typeof p.bodyRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.bodyRevision)) invalid()
  const upload = parseFileUploadIdentity(p.upload, 'INVALID_AGENT_INPUT_RESOURCE')
  if (!upload.mimeType.startsWith('image/')) invalid()
  return { start: p.start as number, end: p.end as number, bodyRevision: p.bodyRevision as string, upload }
}
export function parseAgentInputImages(value: unknown): AgentInputImage[] {
  if (!Array.isArray(value)) invalid()
  return (value as unknown[]).map(item => {
    const p = rpcRecord(item, ['start', 'end', 'bodyRevision', 'upload', 'observation'], 'INVALID_AGENT_INPUT_RESOURCE')
    if (p.observation !== 'confirmed' && p.observation !== 'unavailable') invalid()
    const { observation, ...reference } = p
    return { ...parseAgentInputImageReference(reference), observation: observation as AgentInputImage['observation'] }
  })
}
export function parseAgentInputResourceRead(value: unknown): AgentInputResourceRead {
  const p = rpcRecord(value, ['key', 'index', 'revision', 'maxBytes'], 'INVALID_AGENT_INPUT_RESOURCE')
  const key = validateAgentPromptInputKey(p.key)
  if (key.kind !== 'prompt' || !Number.isSafeInteger(p.index) || Number(p.index) < 0 ||
    typeof p.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.revision) ||
    !Number.isSafeInteger(p.maxBytes) || Number(p.maxBytes) < 1 || Number(p.maxBytes) > FILE_UPLOAD_MAX_BYTES) invalid()
  return { key, index: p.index as number, revision: p.revision as string, maxBytes: p.maxBytes as number }
}
/** Original membership is checked before the Host is asked to inspect any bytes. */
export function inputImageMatches(image: AgentInputImageReference, key: AgentPromptInputKey, body: string, bodyRevision = fileUploadRevision(new TextEncoder().encode(body))): boolean {
  return key.kind === 'prompt' && image.upload.agentSessionId === key.agentSessionId && image.upload.expectedRun.runId === key.expectedRun.runId &&
    image.end <= body.length && image.bodyRevision === bodyRevision
}
export async function resolveAgentInputImages(value: readonly AgentInputImageReference[], key: AgentPromptInputKey, body: string,
  owner: AgentInputResourceOwner | undefined): Promise<AgentInputImage[]> {
  const images = value.map(parseAgentInputImageReference)
  let through = 0
  for (const image of images) {
    if (image.start < through) invalid('Selected image spans must not overlap.')
    through = image.end
  }
  if (!images.length) return []
  const bodyRevision = fileUploadRevision(new TextEncoder().encode(body))
  return await Promise.all(images.map(async image => {
    let observation: AgentInputImage['observation'] = 'unavailable'
    try {
      const receipt = inputImageMatches(image, key, body, bodyRevision) ? await owner?.inspect(image.upload) : undefined
      if (receipt && parseFileUploadResult(receipt, image.upload).status === 'uploaded') observation = 'confirmed'
    } catch { /* Optional image observation cannot prevent the original ordinary input. */ }
    return { ...image, observation }
  }))
}

export function parseAgentInputResourceResult(value: unknown, input: AgentInputResourceRead): AgentInputResourceResult {
  const p = rpcRecord(value, ['key', 'index', 'revision', 'status', 'mimeType', 'name', 'dataBase64', 'byteLength', 'width', 'height', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR')
  if (JSON.stringify(validateAgentPromptInputKey(p.key)) !== JSON.stringify(input.key) || p.index !== input.index || p.revision !== input.revision) invalid('The image response belongs to another original input resource.')
  if (p.status === 'unavailable' && typeof p.code === 'string' && typeof p.message === 'string' && p.dataBase64 === undefined && p.byteLength === undefined) return p as AgentInputResourceResult
  if (p.status !== 'available' || typeof p.mimeType !== 'string' || !p.mimeType.startsWith('image/') || typeof p.name !== 'string' || /[\\/]/u.test(p.name) || typeof p.dataBase64 !== 'string' || !Number.isSafeInteger(p.byteLength) || Number(p.byteLength) < 1 || Number(p.byteLength) > input.maxBytes) invalid('The image response is not a bounded original image.')
  // Decode in the public codec as well; a successful transport is not a byte identity receipt.
  if ((p.dataBase64 as string).length > 4 * Math.ceil(input.maxBytes / 3)) invalid('The image response exceeds the requested byte budget.')
  const bytes = Uint8Array.from(atob(p.dataBase64 as string), char => char.charCodeAt(0))
  const checked = imageBytes(bytes, input.maxBytes, p.mimeType as string)
  if (bytes.length !== p.byteLength || fileUploadRevision(bytes) !== input.revision || checked.status !== 'read' || checked.width !== p.width || checked.height !== p.height) invalid('The image response bytes differ from the original selected image.')
  return p as AgentInputResourceResult
}
