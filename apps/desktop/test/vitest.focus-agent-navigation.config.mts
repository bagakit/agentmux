import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from './vitest.performance-reading.config.mts'
export const focusAgentNavigationMutations = [
  { name: 'host', file: 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', before: 'session.control.hostId === agentReveal.hostId && ', after: '', assertion: 'reveals the exact Host through the actual App without a Region and never substitutes another Host' },
  { name: 'filters', file: 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', before: 'const filtered = revealRow && !matched.includes(revealRow) ? [...matched, revealRow] : matched', after: 'const filtered = matched', assertion: 'temporarily reveals a filtered and lazy target while preserving the original filters and view reading' },
  { name: 'body', file: 'apps/desktop/src/renderer/src/components/FocusContextCards.tsx', before: 'const full = visited.current.has(contextKey(context)) || requested', after: 'const full = visited.current.has(contextKey(context))', assertion: 'mounts and scrolls a real offscreen lazy card before the public receipt confirms it' },
  { name: 'scroll', file: 'apps/desktop/src/renderer/src/components/FocusContextCards.tsx', before: 'if (dy || dx) rows.scrollBy({ top: dy, left: dx, behavior: \'instant\' })', after: 'void dy; void dx', assertion: 'mounts and scrolls a real offscreen lazy card before the public receipt confirms it' },
  { name: 'clip', file: 'apps/desktop/src/renderer/src/lib/desktop-presentation.ts', before: "if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY))", after: 'if (false)', assertion: 'reports a retained card clipped by its original Focus workface as hidden' },
  { name: 'map-consumer', file: 'apps/desktop/src/renderer/src/App.tsx', before: 'onViewInFocus={(subject, presentationSessionId) => useAppStore.getState().revealFocusAgent(subject, presentationSessionId)}', after: 'onViewInFocus={() => {}}', assertion: 'routes View in Focus through the actual Map and App and preserves ordinary view selections' },
  { name: 'toolbar-subject', file: 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', before: 'const selected = executionRows.find(row => row.id === shownSessionId)', after: 'const selected = revealedContext?.context ?? executionRows.find(row => row.id === shownSessionId)', assertion: 'reveals a Mote card without selecting it as an execution task or navigating Space' },
  { name: 'unrelated-subscription', file: 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', before: 'const agentReveal = useAppStore(state => state.focusAgentReveal)', after: 'useAppStore(state => state.sessions); const agentReveal = useAppStore(state => state.focusAgentReveal)', assertion: 'keeps a hidden Focus reader stable when unrelated Session snapshots change' },
  { name: 'visible-receipt', file: 'packages/core/src/desktop-focus-parser.ts', before: " || result.focus.agent.state !== 'visible'", after: '', assertion: 'rejects receipts that only selected Focus or mismatched the visible exact Agent' }
] as const
const name = process.env.AGENTMUX_FOCUS_AGENT_MUTATION
const mutation = focusAgentNavigationMutations.find(item => item.name === name)
if (name && !mutation) throw Error('Unknown Focus Agent navigation mutation')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export default defineConfig({ ...base, cacheDir: '.cache/focus-agent-navigation', plugins: [...base.plugins!, {
 name: 'actual-focus-agent-navigation', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let effective = source
  if (mutation?.file === path) {
   if (source.split(mutation.before).length !== 2) throw Error('Unique Focus navigation mutation anchor required')
   effective = source.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_FOCUS_AGENT_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_AGENT_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(effective), mutated: source !== effective }) + '\n')
  return source === effective ? undefined : { code: effective, map: null }
 }}], test: { ...base.test, setupFiles: ['vitest.setup.ts'], include: ['apps/desktop/test/focus-agent-navigation.test.tsx', 'packages/core/test/control-focus-agent.test.ts'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 } })
