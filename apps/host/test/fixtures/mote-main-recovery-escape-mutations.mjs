import { createHash } from 'node:crypto'
const service = 'packages/core/src/public-rpc-service.ts'
export const mutations = {
  'old-query-route-forgotten': [service, 'let route = await journal.readMoteMainInputRoute(main.identity,operationId)', 'let route = submit ? null : await journal.readMoteMainInputRoute(main.identity,operationId)', '^typed missing-handle'],
  'wrong-unavailable-reason': ['packages/core/src/agent-session-recovery/continuity-policy.ts', "facts.nativeConversationAbsent ? 'native-conversation-absent' : 'native-handle-unavailable'", "'provider-unavailable'", '^typed missing-handle'],
  'entry-inspect-mutates': [service, "if (method === 'space.mote.dialogue.recovery.inspect') return { operation: prior ?? pending }", 'if (false) return { operation: prior ?? pending }', '^typed missing-handle'],
  'managed-entry-allowed': [service, "if (caller) throw new AgentMuxError('Opening a Mote main dialogue requires", "if (false) throw new AgentMuxError('Opening a Mote main dialogue requires", '^managed SDK'],
  'binding-disconnected': ['packages/core/src/mote/main-setup.ts', 'const saved = await ports.save(binding)', "const saved = { status: 'unconfirmed', message: 'Original CAS disconnected', source: null } as any", '^typed missing-handle']
}
const sources = new Set([service, 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/mote/main-setup.ts', 'packages/core/src/mote/dialogue-contract.ts', 'packages/core/src/spatial-agent-open.ts', 'packages/core/src/agentmux-cli-commands.ts', 'apps/host/src/spatial-agent-control.ts', 'apps/host/src/mote-dialogue.ts', 'apps/host/src/mote-quick-preferences.ts', 'apps/host/test/helpers/mote-conversation-start-fixture.ts'])
export function instrumentEscape(source, file) {
  if (!sources.has(file)) return source
  const name = process.env.MOTE_ESCAPE_MUTATION, mutation = name && mutations[name]
  if (name && !mutation) throw Error('Unknown exact public-owner mutation')
  let loaded = source
  if (mutation?.[0] === file) { if (source.split(mutation[1]).length !== 2) throw Error('Exact escape mutation anchor required: ' + name); loaded = source.replace(mutation[1], mutation[2]) }
  if (!process.env.MOTE_ESCAPE_LOADED) return loaded
  const sha = value => createHash('sha256').update(value).digest('hex'), row = JSON.stringify({ file, originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: loaded === source ? null : name }) + '\n'
  return "import {appendFileSync as __escapeLoaded} from 'node:fs';\n__escapeLoaded(" + JSON.stringify(process.env.MOTE_ESCAPE_LOADED) + ',' + JSON.stringify(row) + ');\n' + loaded
}
