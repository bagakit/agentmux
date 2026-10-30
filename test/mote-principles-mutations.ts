import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
export const variants: Record<string, { file: string; before: string; after: string; count?: number }> = {
  'missing-role': { file: '/apps/host/src/mote-resources.ts', before: "snapshot.kind === 'mote' ? [MOTE_COORDINATION_ROLE]", after: 'false ? [MOTE_COORDINATION_ROLE]' },
  'wrong-role': { file: '/apps/host/src/mote-topic-model.ts', before: 'its current main Agent can change', after: 'every Agent is the main Agent' },
  'overwrite-user-guide': { file: '/apps/host/src/mote-resources.ts', before: 'constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW', after: 'constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW' },
  'mix-user-text': { file: '/apps/desktop/src/main/runtime-controller.ts', before: '{ prompt: request.prompt }', after: '{ prompt: agentMuxNote + request.prompt }', count: 2 },
  'mobile-note-retention': { file: '/apps/mobile/src/conversation/local-drafts.ts', before: '...(intent.agentMuxNote === undefined ? {} : { agentMuxNote: intent.agentMuxNote }),', after: '' },
  'mobile-note-retry': { file: '/apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: '...(attempt.agentMuxNote === undefined ? {} : { agentMuxNote: attempt.agentMuxNote }),', after: '...(attempt.moteSource ? { agentMuxNote: MOTE_INPUT_GUIDANCE } : {}),', count: 2 },
  'desktop-note-wire': { file: '/apps/desktop/src/renderer/src/store.ts', before: '[agentMuxNote, MOTE_INPUT_GUIDANCE].filter(Boolean)', after: '[agentMuxNote].filter(Boolean)' }
}
export function motePrinciplesMutation() {
  const name = process.env.AGENTMUX_PRINCIPLES_MUTATION, change = name && variants[name]
  if (name && !change) throw Error('Unknown Mote principles mutation')
  return { name: 'loaded-mote-principles-source', enforce: 'pre' as const, transform(code: string, id: string) {
    if (!change || !id.split('?')[0]!.endsWith(change.file)) return
    const count = code.split(change.before).length - 1
    if (count !== (change.count ?? 1)) throw Error('Mote principles mutation anchor changed: ' + name + ' count=' + count)
    const changed = code.replaceAll(change.before, change.after), trace = process.env.AGENTMUX_PRINCIPLES_TRACE
    if (!trace) throw Error('Loaded mutation source trace required')
    const sha = (v: string) => createHash('sha256').update(v).digest('hex')
    appendFileSync(trace, JSON.stringify({ name, file: id.split('?')[0], count, before: sha(code), after: sha(changed) }) + '\n')
    return changed
  } }
}

/** String asset exports precede the public lib wildcard; all resolve in this candidate tree. */
export function motePrinciplesAssets() {
  const directory = resolve(import.meta.dirname, '../packages/client-ui')
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
    .map(([entry, target]) => ({ find: new RegExp('^' + ('@agentmux/client-ui' + (entry === '.' ? '' : entry.slice(1))).split('*').map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)') + '$'), replacement: resolve(directory, target.replace('*', '$1')) }))
}
