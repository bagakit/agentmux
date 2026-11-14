import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { readControlJsonInput } from './cli-json-input.js'
import { CAPTURE_SEQUENCE_METHODS, parseCaptureSequenceParams, type CaptureSequenceMethod } from './capture-sequence.js'
import { AgentMuxError } from './errors.js'
export const CAPTURE_SEQUENCE_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (Object.keys(CAPTURE_SEQUENCE_METHODS) as CaptureSequenceMethod[]).map(method => ({
  method, summary: method === 'capture.sequence.open' ? 'Open a manual region scrolling capture or GIF recording.' : method === 'capture.sequence.read' ? 'Read the original sequence artifact with embedded GIF keyframe metadata.' : method === 'capture.sequence.stop' ? 'Stop the original recording and keep its captured frames for review.' : 'Inspect the original capture sequence without replaying it.',
  usage: '--input FILE|-', flags: { '--input': 'data' },
  details: 'JSON: {hostId,operationId}; open adds mode:"scroll"|"gif". Open presents a region picker and recording controls; it does not silently start recording or scroll another application. Retain the operation ID after unknown. Inspect/read never restart capture. Read accepts optional offsetBytes and maxBytes (1–8388608; default 8 MiB) and returns byte-window metadata plus whole-file sha256; continue the same operation at nextOffsetBytes until null. Read includes artifact:{mimeType,data:BASE64} after export. GIF keyframe notes and zero-based frame indices are embedded inside that file. This capability does not send any draft.',
  parse: async args => { if (args.length !== 2 || args[0] !== '--input') throw new AgentMuxError('Use --input FILE|- for the original capture sequence.', 'INVALID_CLI_ARGUMENTS'); return parseCaptureSequenceParams(method, await readControlJsonInput(args[1]!, 'Capture sequence')) as unknown as Record<string, unknown> }
}))
