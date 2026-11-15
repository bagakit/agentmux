import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import base from '../scripts/fixtures/agent-schedules/vitest.config.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const renderer = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({
  find: new RegExp('^' + name + '$'), replacement: require.resolve(name)
}))
const variant = process.env.AMUX_GROUP_RELIABILITY_MUTANT
if (variant && variant !== 'overlap-poll' && variant !== 'lock-conflict') throw Error('Unknown Mote Group reliability mutant')
const mutation = variant === 'overlap-poll'
  ? ['MoteGroupConversation.tsx', 'if (quiet && reading.current !== null) return', 'if (false && quiet && reading.current !== null) return'] as const
  : ['MoteGroupSettings.tsx', "issue.code === 'MOTE_GROUP_REVISION_CONFLICT'", "issue.code === 'CONTROL_FAILED'"] as const

export default { ...base, esbuild: { jsx: 'automatic' as const },
  resolve: { ...base.resolve, alias: [...renderer, ...base.resolve.alias] },
  plugins: [...base.plugins, { name: 'mote-group-reliability-mutation', enforce: 'pre' as const, load(id: string) {
    if (!variant || id.split('?')[0] !== resolve(base.root, 'packages/client-ui/src/components', mutation[0])) return
    const source = readFileSync(id, 'utf8')
    if (source.split(mutation[1]).length !== 2) throw Error('Mote Group reliability mutant must load its unique production anchor')
    return source.replace(mutation[1], mutation[2])
  } }],
  test: { environment: 'happy-dom', include: ['apps/desktop/test/mote-group-reliability.test.tsx'], passWithNoTests: false } }
