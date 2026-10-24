import { readControlJsonInput } from './cli-json-input.js'
import { parseNativeDesktopParams, type NativeDesktopMethod } from './public-rpc-native-desktop.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

const summaries: Record<NativeDesktopMethod, string> = {
  'native.capabilities': 'Discover this Host’s exact native instance and supported methods.',
  'native.apps.list': 'List real OS process identities without activating an app.',
  'native.displays.list': 'List exact display IDs, Quartz bounds and backing scales.',
  'native.windows.list': 'List windows of one original OS process.',
  'native.snapshot': 'Observe the exact window and machine AX action references.',
  'native.permissions.inspect': 'Read permission preflight facts without requesting a grant.',
  'native.capture': 'Capture an explicit screen selection, display, rectangle or exact window.',
  'native.clipboard.read': 'Read native text or PNG without input or focus changes.',
  'native.clipboard.write': 'Write exact native text or PNG without pasting.',
  'native.action': 'Submit one typed action against the original process, window and snapshot.',
  'native.operation.inspect': 'Inspect an original operation without starting another native instance.'
}
export const AGENTMUX_NATIVE_DESKTOP_CLI_COMMANDS: readonly AgentMuxCliCommand[] =
  (Object.entries(summaries) as [NativeDesktopMethod, string][]).map(([method, summary]) => ({
    method, summary, usage: '--data <FILE|->', flags: { '--data': 'data' },
    details: `JSON input always has hostId. Begin with native capabilities using {"hostId":"EXACT_HOST"}; keep its instanceId. All later calls require that exact instanceId. Windows use target:{pid,processStartedAt}; snapshot/action and window capture also require windowId. Actions require operationId, snapshotId and a finite typed action (click, performSecondaryAction, setValue, typeText, pressKey, hotkey, pasteText, scroll, drag). Use returned original AX action names and element indexes, never tree labels. Capture requires operationId and capture:{mode:"selection"|"display"|"rect"|"window",...}. Coordinates are Quartz points for capture and window-relative for AX actions. Clipboard format is text or png; PNG data is base64 and text is preserved exactly. A responded envelope confirms the response, not an input’s effect; retain business verification and the original operation. Unknown results must not be automatically replayed. native operation inspect requires the original operationId and instanceId and never creates a replacement process. Permission queries do not grant OS authorization. Snapshot defaults to AX-only; use explicit capture for pixels. Host support can be unavailable while Agents and Browser page capture remain usable.`,
    parse: async args => {
      if (args.length !== 2 || args[0] !== '--data' || !args[1]) throw new AgentMuxError('Native commands require exactly --data <FILE|->.', 'INVALID_CLI_ARGUMENT')
      return parseNativeDesktopParams(method, await readControlJsonInput(args[1], 'Native desktop')) as unknown as Record<string, unknown>
    }
  }))
