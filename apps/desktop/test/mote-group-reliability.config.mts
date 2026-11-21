import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import base from '../scripts/fixtures/agent-schedules/vitest.config.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const renderer = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({
  find: new RegExp('^' + name + '$'), replacement: require.resolve(name)
}))
const variant = process.env.AMUX_GROUP_RELIABILITY_MUTANT
const mutations = {
  'overlap-poll': ['MoteGroupConversation.tsx', 'if (quiet && reading.current !== null) return', 'if (false && quiet && reading.current !== null) return'],
  'lock-conflict': ['MoteGroupSettings.tsx', "issue.code === 'MOTE_GROUP_REVISION_CONFLICT'", "issue.code === 'CONTROL_FAILED'"],
  'invite-gone': ['MoteGroupSettings.tsx', 'disabled={changing || !selectedInvitees.length}', 'disabled={changing || !invite.length}'],
  'keep-inactive-avatar': ['MoteGroupSettings.tsx', 'const retained = changes.avatarMoteIds.filter(id => active.some(member => member.moteId === id))',
    'const retained = changes.avatarMoteIds'],
  'miss-exact-mention': ['MoteGroupConversation.tsx', '...value.recipientIds, member.moteId', '...value.recipientIds'],
  'conflate-reports': ['MoteAssignment.tsx', 'reply.replyToMessageId === target.messageId ? [reply.author.moteId]', 'true ? [reply.author.moteId]'],
} as const
const mutation = variant ? mutations[variant as keyof typeof mutations] : undefined
if (variant && !mutation) throw Error('Unknown Mote Group reliability mutant')

export default { ...base, esbuild: { jsx: 'automatic' as const },
  resolve: { ...base.resolve, alias: [...renderer, ...base.resolve.alias] },
  plugins: [...base.plugins, { name: 'mote-group-reliability-mutation', enforce: 'pre' as const, load(id: string) {
    if (!mutation || id.split('?')[0] !== resolve(base.root, 'packages/client-ui/src/components', mutation[0])) return
    const source = readFileSync(id, 'utf8')
    if (source.split(mutation[1]).length !== 2) throw Error('Mote Group reliability mutant must load its unique production anchor')
    return source.replace(mutation[1], mutation[2])
  } }],
  test: { environment: 'happy-dom', include: ['apps/desktop/test/mote-group-reliability.test.tsx'], passWithNoTests: false } }
