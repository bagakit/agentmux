import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
const mutations = {
  'healthy-lost': ['GlobalFocusSurface.tsx', " && context.processState !== 'running'", ''],
  'idle-mix': ['GlobalFocusSurface.tsx', "? 'disconnected' : context.bucket", "? 'idle' : context.bucket"],
  'topic-parent': ['FocusProjectLanes.tsx', "lane.objectKind === 'topic' || lane.objectKind === 'mote'", "lane.objectKind === 'mote'"],
  'search-aria': ['FocusDisconnectedGroup.tsx', 'aria-expanded={showing}', 'aria-expanded={expanded}']
} as const
const key = process.env.AGENTMUX_FOCUS_LANE_MUTATION as keyof typeof mutations
if (!Object.hasOwn(mutations, key)) throw new Error('Select one bounded Focus lane mutation.')
const [file, from, to] = mutations[key]
export default defineConfig({ ...original, plugins: [{ name: 'focus-lane-loaded-mutation', enforce: 'pre', transform(code, id) {
  if (!id.replaceAll('\\', '/').endsWith(`/components/${file}`)) return
  if (!code.includes(from) || code.indexOf(from) !== code.lastIndexOf(from)) throw new Error('Mutation must match one real owning Source expression.')
  const changed = code.replace(from, to)
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const record = { mutation: key, id, originalSha: sha(code), transformedSha: sha(changed), from, to }
  if (!process.env.AGENTMUX_FOCUS_LANE_MUTATION_LOG) throw new Error('Loaded mutation receipt is required.')
  appendFileSync(process.env.AGENTMUX_FOCUS_LANE_MUTATION_LOG, JSON.stringify(record)+'\n')
  return { code: changed, map: null }
} }] })
