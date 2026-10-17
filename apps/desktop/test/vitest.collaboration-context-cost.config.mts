import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from './vitest.collaboration-space-product.config.mts'
export const collaborationContextMutation = {
  name: 'unscoped-context', file: 'components/AgentCollaborationDialog.tsx',
  before: ' || !wanted.has(collaborationSubjectKey(session.control))', after: '',
  assertion: 'builds production contexts only for the focused Agent and recorded peers as unrelated Sessions grow'
} as const
const selected = process.env.AGENTMUX_COLLABORATION_CONTEXT_MUTATION
if (selected && selected !== collaborationContextMutation.name) throw Error('Unknown context mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], { name: 'collaboration-context-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (selected && path === 'apps/desktop/src/renderer/src/' + collaborationContextMutation.file) {
    if (code.split(collaborationContextMutation.before).length !== 2) throw Error('Unique context mutation anchor required')
    code = code.replace(collaborationContextMutation.before, collaborationContextMutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_CONTEXT_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_CONTEXT_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: source !== code }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: { ...shared.test, include: ['apps/desktop/test/collaboration-context-cost.test.tsx'], passWithNoTests: false } })
