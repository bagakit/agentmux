import { createHash } from 'node:crypto'
import { readControlJsonInput } from './cli-json-input.js'
import { writeNewCliFile } from './cli-atomic-file.js'
import { AgentMuxError } from './errors.js'
import { APP_CAPTURE_LIMITS, APP_CAPTURE_METHODS, parseAppCaptureParams, parseAppCaptureFrame, parseAppRecording,
  type AppCaptureMethod } from './app-capture.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

export const APP_CAPTURE_CLI_COMMANDS: readonly AgentMuxCliCommand[] = Object.keys(APP_CAPTURE_METHODS).map(name => {
  const method = name as AppCaptureMethod, binary = method === 'app.capture' || method === 'app.record.read'
  return { method, usage: `--input FILE|-${binary ? ' [--output FILE]' : ''}`,
    summary: method === 'app.capture' ? 'Capture this exact App window or presented Region as PNG.'
      : method === 'app.record.start' ? 'Start one bounded WebM recording with its original operation ID.'
      : method === 'app.record.stop' ? 'Stop only this original workface recording and finish its encoder.'
      : method === 'app.record.read' ? 'Read the saved WebM from this exact original recording.' : 'Inspect the original recording without starting it again.',
    flags: { '--input': 'data', ...(binary ? { '--output': 'data' as const } : {}) },
    details: `Discover windowId/documentGeneration through app window ls. JSON target may also carry region:{kind:"region",displayWorkspaceId,groupId,tabId,regionId} from space inspect. Capture takes {target}; record start takes {operationId,target,durationMs,fps}; inspect/stop/read take {operationId}. No focus or navigation is performed. Recording uses up to ${APP_CAPTURE_LIMITS.maxFps} fps, ${APP_CAPTURE_LIMITS.maxDurationMs} ms, ${APP_CAPTURE_LIMITS.maxVideoWidth}x${APP_CAPTURE_LIMITS.maxVideoHeight} encoded pixels and ${APP_CAPTURE_LIMITS.maxVideoBytes} encoded bytes. These budgets only scope this capture. Keep the original operation after an unknown response; inspect it, never start another recording to recover a receipt. Output creates a new local file without overwriting. Source pixels and recording belong to Desktop; Agents, drafts and layouts are retained.`,
    parse: async args => {
      let carrier: string | undefined, output: string | undefined
      for (let i = 0; i < args.length; i++) {
        const argument = args[i]!, separator = argument.indexOf('=')
        const option = separator < 0 ? argument : argument.slice(0, separator)
        const v = separator < 0 ? args[++i] : argument.slice(separator + 1)
        if (!v || option !== '--input' && (option !== '--output' || !binary) ||
          option === '--input' && carrier !== undefined || option === '--output' && output !== undefined) {
          throw new AgentMuxError('Capture commands require --input FILE|- and may write --output FILE once.', 'INVALID_CLI_ARGUMENT')
        }
        if (option === '--input') carrier = v
        else { if (v === '-') throw new AgentMuxError('Capture output requires a named new file.', 'INVALID_CLI_ARGUMENT'); output = v }
      }
      if (!carrier) throw new AgentMuxError('--input FILE|- is required.', 'INVALID_CLI_ARGUMENT')
      return parseAppCaptureParams(method, await readControlJsonInput(carrier, 'Original App capture')) as unknown as Record<string, unknown>
    }
  }
})

export async function writeAppCaptureFile(path: string, method: string, result: unknown) {
  let data: Buffer, expected: string | null = null
  if (method === 'app.capture') data = Buffer.from(parseAppCaptureFrame(result).image.data, 'base64')
  else {
    const p = result as { recording?: unknown; video?: { data: string } }
    if (!p.recording || !p.video) throw new AgentMuxError('The original recording has no saved video. Inspect its original operation; no recording was replayed.', 'APP_RECORDING_UNAVAILABLE')
    const recording = parseAppRecording(p.recording)
    data = Buffer.from(p.video.data, 'base64'); expected = recording.sha256
    if (data.length !== recording.bytes) throw new AgentMuxError('The recording bytes changed before export.', 'CONTROL_PROTOCOL_ERROR')
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (expected && sha256 !== expected) throw new AgentMuxError('The original recording checksum does not match; no file was published.', 'CONTROL_PROTOCOL_ERROR')
  return { ...await writeNewCliFile(path, async write => { await write(data) }), sha256 }
}
export function appCaptureCliMetadata(method: string, result: unknown): unknown {
  if (method === 'app.capture') {
    const frame = result as { image: { data: string } }
    const { data: _pixels, ...image } = frame.image
    return { ...frame, image }
  }
  const { video: _video, ...metadata } = result as Record<string, unknown>
  return metadata
}
