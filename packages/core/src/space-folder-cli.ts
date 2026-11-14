import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseFolderSpaceRegistration } from './space-folder.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

export const SPACE_FOLDER_CLI_COMMANDS: readonly AgentMuxCliCommand[] = [{
  method: 'space.folder.register', usage: '--runtime ORIGINAL_RUNTIME --workspace ORIGINAL_WORKSPACE --input RESOURCE_JSON|-',
  summary: 'Explicitly register the selected Host’s already configured Folder as its original Space and Zone.',
  details: 'Input is the selected source resource pin {hostId,workspacePath,projectRootPath}, copied from that Host’s original Workspace metadata. Labels are not identity. The Host reads its own configuration and writes only the original Space/Zone/binding; this does not register a new directory or import a client graph. Retain the entire original request if its save reply is unknown. Inspect the same endpoint with space.ls and match the exact Folder, Workspace Zone and binding before reading its original snapshot. Do not automatically register again, choose another directory or recompute an identity from a client Host alias.',
  flags: { '--runtime': 'data', '--workspace': 'data', '--input': 'data' },
  parse: async args => {
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1]
      if (!['--runtime', '--workspace', '--input'].includes(flag) || flags.has(flag) || value === undefined) {
        throw new AgentMuxError('Use each exact Folder registration flag once; see --help.', 'INVALID_CLI_ARGUMENT')
      }
      flags.set(flag, value)
    }
    return parseFolderSpaceRegistration({ runtimeId: flags.get('--runtime'), workspaceId: flags.get('--workspace'),
      expectedResource: await readControlJsonInput(flags.get('--input') ?? '', 'Original Folder resource') }) as unknown as Record<string, unknown>
  }
}]
