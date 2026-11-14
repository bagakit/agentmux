import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { pngImageDimensions } from './png-image.js'
import { writeNewCliFile } from './cli-atomic-file.js'

/** A CLI projection of browser.run, not a second screenshot business service. */
export function browserCaptureProgram(options: { within?: string; clip?: unknown; pixelRatio?: number }): string {
  return `return await captureScreenshot(${JSON.stringify(options)})`
}

function captureOf(report: unknown): Record<string, unknown> {
  const r = report as { outcome?: { kind?: string }; result?: unknown }
  if (r?.outcome?.kind !== 'completed' || !r.result || typeof r.result !== 'object') {
    throw new AgentMuxError('The original screenshot program did not complete. Inspect its operation; capture was not repeated.', 'BROWSER_CAPTURE_UNAVAILABLE')
  }
  return r.result as Record<string, unknown>
}

/** Continue the original bounded result through readResult; never recapture its page. */
export async function resolveBrowserCaptureReport(report: unknown, browserId: string,
  read: (code: string) => Promise<unknown>): Promise<unknown> {
  const reference = captureOf(report)
  if (reference.kind !== 'browser-result-artifact') return report
  const total = reference.byteLength
  if (reference.browserId !== browserId || reference.format !== 'json' || !Number.isSafeInteger(total) ||
      Number(total) < 1 || Number(total) > 8 * 1024 * 1024 || reference.maxReadBytes !== 65536) {
    throw new AgentMuxError('The retained screenshot result is not bound to this Browser or exceeds its result contract.', 'CONTROL_PROTOCOL_ERROR')
  }
  const chunks: Buffer[] = []
  for (let offset = 0; offset < Number(total);) {
    const continued = await read(`return await readResult(${JSON.stringify(reference)},{offset:${offset},maxBytes:65536})`) as {
      outcome?: { kind?: string }; runOperation?: { id?: string }; result?: unknown
    }
    if (continued?.outcome?.kind !== 'completed') {
      throw new AgentMuxError(`Retained screenshot result read ${continued?.runOperation?.id ?? '(unconfirmed)'} did not complete. The original screenshot remains captured and was not repeated.`,
        'BROWSER_CAPTURE_RESULT_READ_FAILED', JSON.stringify({ readOperationId: continued?.runOperation?.id, outcome: continued?.outcome }))
    }
    const chunk = captureOf(continued)
    const bytes = typeof chunk.data === 'string' ? Buffer.from(chunk.data, 'base64') : Buffer.alloc(0)
    const next = offset + bytes.length
    if (!isDeepStrictEqual(chunk.reference, reference) || chunk.encoding !== 'base64' || chunk.offset !== offset ||
        chunk.totalBytes !== total || !bytes.length || bytes.length > 65536 || bytes.toString('base64') !== chunk.data ||
        chunk.returnedBytes !== bytes.length || next > Number(total) || chunk.nextOffset !== (next === total ? null : next)) {
      throw new AgentMuxError('The retained screenshot continuation changed or made no progress. The original capture was not repeated.', 'CONTROL_PROTOCOL_ERROR')
    }
    chunks.push(bytes); offset = next
  }
  return { ...(report as Record<string, unknown>), result: JSON.parse(Buffer.concat(chunks).toString('utf8')), resultArtifact: reference }
}

export async function writeBrowserCaptureFile(path: string, report: unknown) {
  const capture = captureOf(report), image = capture.image as { mimeType?: string; dataUrl?: string; width?: number; height?: number; byteLength?: number }
  if (image?.mimeType !== 'image/png' || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith('data:image/png;base64,')) throw new AgentMuxError('The original capture has no bounded PNG payload.', 'CONTROL_PROTOCOL_ERROR')
  const data = image.dataUrl.slice('data:image/png;base64,'.length), size = pngImageDimensions(data, 'CONTROL_PROTOCOL_ERROR')
  const bytes = Buffer.from(data, 'base64')
  if (size.width !== image.width || size.height !== image.height || bytes.length !== image.byteLength) throw new AgentMuxError('Screenshot PNG dimensions or byte count changed before export.', 'CONTROL_PROTOCOL_ERROR')
  return { ...await writeNewCliFile(path, async write => { await write(bytes) }), sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** The original report and operation remain available; only bulky image bytes leave stdout. */
export function browserCaptureCliMetadata(report: unknown): unknown {
  const r = report as { result?: unknown }
  if (!r?.result || typeof r.result !== 'object') return report
  const capture = r.result as Record<string, unknown>, image = capture.image
  if (!image || typeof image !== 'object') return report
  const { dataUrl: _pixels, ...metadata } = image as Record<string, unknown>
  return { ...r, result: { ...capture, image: metadata } }
}
