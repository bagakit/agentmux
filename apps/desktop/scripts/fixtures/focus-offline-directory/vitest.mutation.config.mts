import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'

const mutations = {
  'default-directory': ['GlobalFocusSurface.tsx', '(onlyDisconnected || disconnectedOpen)', 'disconnectedOpen && !onlyDisconnected'],
  'directory-filter': ['FocusDisconnectedProjects.tsx', 'const context = visibleIds.has(id) ? contexts.get(id) : null', 'const context = contexts.get(id)'],
  'directory-excerpt': ['FocusContextRow.tsx', 'directory || context.bucket', '!directory && context.bucket'],
  'precise-return': ['FocusDisconnectedProjects.tsx', 'target?.focus({ preventScroll: true })', 'fallbackFocus.current?.focus({ preventScroll: true })']
} as const
const key = process.env.AGENTMUX_FOCUS_OFFLINE_MUTATION as keyof typeof mutations
if (!Object.hasOwn(mutations, key)) throw new Error('Select one bounded directory mutation.')
const [file, from, to] = mutations[key]
export default defineConfig({ ...original, plugins: [{ name: 'focus-offline-loaded-mutation', enforce: 'pre', transform(code, id) {
  if (!id.replaceAll('\\', '/').endsWith(`/components/${file}`)) return
  if (!code.includes(from) || code.indexOf(from) !== code.lastIndexOf(from)) throw new Error('Mutation must match one owning expression.')
  const changed = code.replace(from, to)
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (!process.env.AGENTMUX_FOCUS_OFFLINE_MUTATION_LOG) throw new Error('Loaded mutation receipt is required.')
  appendFileSync(process.env.AGENTMUX_FOCUS_OFFLINE_MUTATION_LOG, JSON.stringify({ mutation: key, file, originalSha: sha(code), transformedSha: sha(changed), from, to }) + '\n')
  return { code: changed, map: null }
} }] })
