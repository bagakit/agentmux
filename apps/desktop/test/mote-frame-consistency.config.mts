import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import owning from './mote-primary-agent.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'duplicate-banner': ['apps/desktop/src/renderer/src/components/MoteSpaceFrame.tsx', 'presentation="navigation"', 'presentation="bar"'],
  'duplicate-profile': ['apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', "hidden={section !== 'profile' || discussion}", 'hidden={false}'],
  'eager-connections': ['apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', '<details className="mote-profile__preferences"', '<details open className="mote-profile__preferences"']
} as const
export default defineConfig({ ...owning, plugins: [...owning.plugins ?? [], {
  name: 'mote-frame-loaded-mutation', enforce: 'pre', transform(code, id) {
    const mutation = process.env.AGENTMUX_MOTE_FRAME_MUTATION as keyof typeof mutations | undefined
    if (!mutation) return
    if (!mutations[mutation]) throw new Error('Unknown frame mutation')
    const [path, before, after] = mutations[mutation]
    if (relative(root, id.split('?')[0]!) !== path) return
    if (code.split(before).length !== 2) throw new Error('Mutation must change exactly one production branch')
    const changed = code.replace(before, after)
    if (process.env.AGENTMUX_MOTE_FRAME_TRACE) appendFileSync(process.env.AGENTMUX_MOTE_FRAME_TRACE,
      JSON.stringify({ mutation, path, before: createHash('sha256').update(code).digest('hex'), after: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return { code: changed, map: null }
  }
}], test: { ...owning.test, include: ['test/mote-frame-consistency.test.tsx', 'test/mote-team-cooperation.test.tsx'], passWithNoTests: false, testTimeout: 30000 } })
