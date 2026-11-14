import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { AgentMuxError } from './errors.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseFolderSpaceRegistration, parseFolderSpaceRegisterInput, parseFolderDirectoryInspectInput } from './space-folder.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

function flags(args: readonly string[], allowed: readonly string[]): Map<string,string> {
  args = expandCliOptionAssignments(args)
  const result = new Map<string,string>()
  for (let i=0;i<args.length;i+=2) {
    const flag=args[i]!, value=args[i+1]
    if (!allowed.includes(flag) || result.has(flag) || value === undefined) throw new AgentMuxError('Use each exact Folder flag once; see --help.', 'INVALID_CLI_ARGUMENT')
    result.set(flag,value)
  }
  return result
}
export const SPACE_FOLDER_CLI_COMMANDS: readonly AgentMuxCliCommand[] = [{
  method: 'space.folder.inspect', usage: '--input REQUEST_JSON|-',
  summary: 'Observe one original Source directory and its current Folder registrations without writing.',
  details: 'Input {runtimeId,path,expectedResource?} names the Source Runtime and absolute path. The Files owner returns a physical directory witness and exact existing registrations or a typed issue. This read neither admits a directory nor grants execution or Node sharing. Keep the returned directory object for an explicit register. After an unknown write inspect the same frozen expectedResource; a current match is not the lost write acknowledgement.',
  flags: { '--input': 'data' },
  parse: async args => { const p=flags(args,['--input']); return parseFolderDirectoryInspectInput(await readControlJsonInput(p.get('--input') ?? '', 'Original directory inspection')) as unknown as Record<string,unknown> }
}, {
  method: 'space.folder.register', usage: '--input REQUEST_JSON|- [--runtime ORIGINAL_RUNTIME --workspace ORIGINAL_WORKSPACE]',
  summary: 'Explicitly register an original configured Folder or owner-confirmed Source directory.',
  details: 'A full public request is {runtimeId,directory,workspaceId?}, using the exact directory object returned by space.folder.inspect; only the original owner/device may admit a new directory. Existing configured resources keep --runtime/--workspace with input {hostId,workspacePath,projectRootPath}. The Source reuses existing IDs or returns newly admitted IDs and confirmed spatial save. It never writes Desktop config, changes Node sharing or grants another execution Core. Keep the full original request on unknown; inspect it rather than minting or automatically registering again.',
  flags: { '--runtime': 'data', '--workspace': 'data', '--input': 'data' },
  parse: async args => {
    const p=flags(args,['--runtime','--workspace','--input']), input=await readControlJsonInput(p.get('--input') ?? '', 'Original Folder registration')
    return (p.has('--runtime') || p.has('--workspace') ? parseFolderSpaceRegistration({ runtimeId:p.get('--runtime'),workspaceId:p.get('--workspace'),expectedResource:input }) : parseFolderSpaceRegisterInput(input)) as unknown as Record<string,unknown>
  }
}]
