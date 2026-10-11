import { createHash } from 'node:crypto'
import { rpcRecord } from './rpc-data.js'
import { AgentMuxError } from './errors.js'
import { writeNewCliFile } from './cli-atomic-file.js'
import { parseRendererAllocationsResult, rendererAllocationsJSON } from './renderer-allocations.js'
import {
  parseRendererSceneCaptureResult,
  parseRendererSceneInspection,
  rendererSceneJSON
} from './renderer-performance-scene.js'
/** Output paths stay local to this CLI. Original files and symlinks are never replaced. */
export async function writeRendererDiagnosticFile(
  path: string,
  result: unknown,
  kind: 'allocations' | 'scene-capture' | 'scene-inspect'
) {
  const body = rpcRecord(result, [kind === 'scene-inspect' ? 'inspection' : 'capture'], 'CONTROL_PROTOCOL_ERROR')
  let text: string
  if (kind === 'allocations') {
    const capture = parseRendererAllocationsResult(body.capture)
    if (capture.profile === null)
      throw new AgentMuxError(
        'No allocation profile was returned. Capture was not retried and no file was written.',
        'CONTROL_UNAVAILABLE'
      )
    text = rendererAllocationsJSON(capture.profile)
    if (createHash('sha256').update(text).digest('hex') !== capture.sha256)
      throw new AgentMuxError('Allocation profile checksum differs. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  } else {
    const scene =
      kind === 'scene-capture'
        ? parseRendererSceneCaptureResult(body.capture).scene
        : parseRendererSceneInspection(body.inspection).scene
    if (!scene)
      throw new AgentMuxError(
        'The requested original scene is not retained. No capture was started and no file was written.',
        'CONTROL_UNAVAILABLE'
      )
    text = rendererSceneJSON(scene)
  }
  const written = await writeNewCliFile(path, text)
  return { ...written, sha256: createHash('sha256').update(text).digest('hex') }
}
