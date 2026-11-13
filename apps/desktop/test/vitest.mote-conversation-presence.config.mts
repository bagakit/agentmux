import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import owning from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const targets = ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
  'apps/desktop/src/renderer/src/components/MoteSpaceFrame.tsx',
  'apps/desktop/src/renderer/src/components/MoteConversationIdentity.tsx']
const mutations = {
  'remove-floating-identity': [targets[0]!, '<MoteConversationIdentity scope={scope} visible={visible} />', '{null}'],
  'remove-space-identity': [targets[1]!, '<MoteConversationIdentity scope={scope} visible={visible} />', '{null}'],
  'ignore-saved-avatar': [targets[2]!, 'manualIcon={appearance}', 'manualIcon={null}'],
  'ignore-main-expression': [targets[2]!, 'moteSessionId={current?.sessionId}', 'moteSessionId={undefined}'],
  'keep-hidden-motion': [targets[2]!, 'visible={visible} moteSessionId=', 'visible={true} moteSessionId=']
} as const
const mutation = process.env.AGENTMUX_MOTE_PRESENCE_MUTATION as keyof typeof mutations | undefined
if (mutation && !mutations[mutation]) throw new Error('Unknown Mote presence mutation')
export default defineConfig({ ...owning, plugins: [...owning.plugins ?? [], {
  name: 'mote-presence-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(repository, id.split('?')[0]!)
    if (!targets.includes(path)) return
    let changed = code
    if (mutation && mutations[mutation][0] === path) {
      const [, before, after] = mutations[mutation]
      if (code.split(before).length !== 2) throw new Error('Mutation must change exactly one loaded production branch')
      changed = code.replace(before, after)
    }
    if (process.env.AGENTMUX_MOTE_PRESENCE_TRACE) appendFileSync(process.env.AGENTMUX_MOTE_PRESENCE_TRACE,
      JSON.stringify({ mutation: mutation ?? null, path, before: createHash('sha256').update(code).digest('hex'),
        after: createHash('sha256').update(changed).digest('hex'), changed: changed !== code }) + '\n')
    return changed === code ? undefined : { code: changed, map: null }
  }
}], test: { ...owning.test, include: ['test/mote-conversation-presence.test.tsx', 'test/mote-frame-consistency.test.tsx'],
  passWithNoTests: false, testTimeout: 30000 } })
