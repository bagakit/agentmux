import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { parseAmuxObjectLink } from './sharing.js'
import { parseSpaceLinkParams, type SpaceLinkMethod } from './space-link.js'
export const SPACE_LINK_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (['space.link.ensure','space.link.resolve'] as const).map((method: SpaceLinkMethod)=>({
  method, usage: method === 'space.link.ensure' ? '--runtime ORIGINAL_RUNTIME --space ORIGINAL_SPACE --operation-id ID [--thread ORIGINAL_EVENT]' : '--url ORIGINAL_URL',
  summary: method === 'space.link.ensure' ? 'Publish a durable path-free address for the exact original Mote or thread.' : 'Read an original public Mote address without registering or opening it.',
  flags: Object.fromEntries((method === 'space.link.ensure' ? ['--runtime','--space','--operation-id','--thread'] : ['--url']).map(flag=>[flag,'data'])) as NonNullable<AgentMuxCliCommand['flags']>,
  details: 'The selected endpoint must own the original Runtime. A public address is not authority or access permission. Publication retains its operation ID and exact target through an unknown write; repeat only that original request. Resolve is read-only and never creates an address. Original Space, event, workface and Agent identities remain unchanged.',
  parse: async args=>{
    const values=new Map<string,string>(),allowed=method==='space.link.ensure'?['--runtime','--space','--operation-id','--thread']:['--url']
    for(let i=0;i<args.length;i+=2){const flag=args[i]!,value=args[i+1];if(!allowed.includes(flag)||values.has(flag)||value===undefined)throw new AgentMuxError('Use the exact Space link flags once each; see --help.','INVALID_CLI_ARGUMENT');values.set(flag,value)}
    if(method==='space.link.resolve') {const parsed=parseAmuxObjectLink(values.get('--url')??'');if(parsed.kind!=='mote'||!parsed.address)throw new AgentMuxError('Resolve requires an original public Mote address. Saved legacy links keep their original focus target.','INVALID_CLI_ARGUMENT');return parseSpaceLinkParams(method,{address:parsed.address})}
    return parseSpaceLinkParams(method,{target:{runtimeId:values.get('--runtime'),spaceId:values.get('--space'),...(values.has('--thread')?{eventId:values.get('--thread')}:{})},operationId:values.get('--operation-id')})
  }
}))
