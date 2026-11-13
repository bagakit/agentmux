import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import owning from './vitest.mote-conversation-presence.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const variants: Record<string, [string, string, string]> = {
  'hidden-workspace-navigation': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
    '!floating && visible ? conversations : null', '!floating ? conversations : null'],
  'stale-run-request': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx',
    '(!request.evidence?.run || request.evidence.run.runId === source!.control.run.runId)', 'true'],
  'main-as-member': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx',
    'onClick={main}>\n            <span><strong>主对话', 'onClick={() => primary && open(primary)}>\n            <span><strong>主对话'],
  'lose-member-reference': ['apps/desktop/src/renderer/src/components/MoteSpaceFrame.tsx',
    "...(next === 'threads' && reference ? { threadReference: reference } : {})", '...{}'],
  'remount-reading': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
    '<div className="mote-workface__original" hidden=', '<div key={section} className="mote-workface__original" hidden=']
}
const mutation = process.env.MOTE_CONVERSATION_MUTATION
if (mutation && !variants[mutation]) throw Error('Unknown conversation navigation mutation')
export default defineConfig({ ...owning,
  // Consume this checkout's existing capsule exports, not another worktree's dist.
  resolve: { ...owning.resolve, alias: [
    ...['', '/node', '/runtime'].map(subpath => ({
      find: '@agentmux/capsule' + subpath,
      replacement: resolve(repository, 'packages/capsule/src', (subpath.slice(1) || 'index') + '.ts')
    })).reverse(),
    ...owning.resolve!.alias as { find: RegExp; replacement: string }[]
  ] },
  plugins: [...owning.plugins ?? [], {
  name: 'mote-conversation-loaded-mutation', enforce: 'pre', transform(code, id) {
    const target = mutation ? variants[mutation]! : null
    if (!target || relative(repository, id.split('?')[0]!) !== target[0]) return
    if (code.split(target[1]).length !== 2) throw Error('Production mutation must hit exactly one loaded expression')
    const trace = process.env.MOTE_CONVERSATION_TRACE
    if (!trace) throw Error('Loaded production mutation needs its original trace')
    const changed = code.replace(target[1], target[2]), hash = (s: string) => createHash('sha256').update(s).digest('hex')
    appendFileSync(trace, JSON.stringify({ mutation, path: target[0], before: hash(code), after: hash(changed) }) + '\n')
    return { code: changed, map: null }
  }
}], test: { ...owning.test, include: ['test/mote-conversation-evolution.test.tsx', 'test/mote-conversation-presence.test.tsx', 'test/mote-frame-consistency.test.tsx', 'test/mote-team-cooperation.test.tsx'], passWithNoTests: false } })
