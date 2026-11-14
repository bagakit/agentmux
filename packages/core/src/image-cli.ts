import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseImageParams, type ImageMethod } from './public-rpc-image.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

const summaries: Record<ImageMethod, string> = {
  'image.pin': 'Pin one authorized PNG as a temporary reference image.',
  'image.inspect': 'Inspect one original image operation or exact pin without changing it.',
  'image.close': 'Close one exact pinned image without changing its source or other workfaces.'
}
export const AGENTMUX_IMAGE_CLI_COMMANDS: readonly AgentMuxCliCommand[] =
  (Object.entries(summaries) as [ImageMethod, string][]).map(([method, summary]) => ({
    method, summary, usage: '--input FILE|-', flags: { '--input': 'data' },
    details: 'JSON always carries the exact hostId. Pin also requires operationId and image:{format:"png",data:BASE64,width,height,scale:1}. Pin may add origin:{x,y,width,height} in global logical points (finite, positive size) to open the pin over the place the pixels came from; without it the pin opens near the pointer. It reads no URL or file and never captures a screen. Inspect takes exactly one of operationId or pinId. Close requires pinId and its own operationId. Keep original operation IDs after unknown; inspect that operation, never automatically replay it. Outer state is the current pin observation; recordedOperation describes the original effect and actor separately. A missing original record is null, not proof the action did not occur. The Desktop owner retains fixed image pixels; closing a pin never closes its original editor, Browser, Session or Run. Missing presentation support affects only this capability.',
    parse: async args => {
      args = expandCliOptionAssignments(args)
      if (args.length !== 2 || args[0] !== '--input' || !args[1]) throw new AgentMuxError('Image commands require exactly --input FILE|-.', 'INVALID_CLI_ARGUMENT')
      return parseImageParams(method, await readControlJsonInput(args[1], 'Original image')) as unknown as Record<string, unknown>
    }
  }))
