import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import original from './a2a-resumed-inbox.config.mts'

const mutations = {
  'source-thread-ignored': ['packages/core/src/mote/supervision.ts', 'dispatch.threadId !== origin.threadId || ', ''],
  'participant-ignored': ['apps/host/src/mote-dialogue.ts', 'await context.readDispatch(link.origin.hostId, link.origin.messageId)', 'await (await options.clientForHost(link.origin.hostId)).readDispatch({ sourceMessageId: link.origin.messageId })'],
  'runtime-participant-ignored': ['packages/core/src/client.ts', 'if (caller && !await this.localMessageParticipant(messages[0]!, caller.agentSessionId))', 'if (false)'],
  'rpc-disconnected': ['packages/core/src/public-rpc-service.ts', 'await this.ports.moteDialogue.supervision(parseMoteDialogueParams(method, params), original)', "await Promise.reject(new AgentMuxError('Original supervision owner disconnected', 'CONTROL_UNAVAILABLE'))"],
  'observation-detached': ['packages/core/src/mote/supervision.ts', 'item.sequence !== links[index]?.sequence', 'false'],
  'input-guidance-disconnected': ['packages/core/src/mote-input-source.ts', '+ "\\n\\n" + MOTE_SUPERVISION_GUIDANCE', '+ ""']
} as const
const mutant = process.env.MOTE_SUPERVISION_MUTANT as keyof typeof mutations | undefined
if (mutant && !mutations[mutant]) throw Error('Choose an exact supervision mutation')
export default defineConfig({ ...original, plugins: [{ name: 'mote-supervision-production-proof', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/') || !path.endsWith('.ts')) return
  let loaded = source
  const change = mutant && mutations[mutant]
  if (change && path === change[0]) {
    if (source.split(change[1]).length !== 2) throw Error('The supervision mutation must match one exact production anchor')
    loaded = source.replace(change[1], change[2])
  }
  if (process.env.MOTE_SUPERVISION_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const entry = JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(source === loaded ? {} : { mutant }) }) + '\n'
    loaded = "import {appendFileSync as __moteSupervisionLoaded} from 'node:fs';\n__moteSupervisionLoaded(" + JSON.stringify(process.env.MOTE_SUPERVISION_LOADED) + ',' + JSON.stringify(entry) + ');\n' + loaded
  }
  return { code: loaded, map: null }
} }, ...original.plugins!], test: { ...original.test, include: ['packages/core/test/mote-supervision.test.ts'], testTimeout: 60_000, passWithNoTests: false } })
