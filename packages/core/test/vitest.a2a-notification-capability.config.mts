import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.a2a-idle-input.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NOTIFICATION_CAPABILITY_MUTATION
if (mutation && mutation !== 'missing-transport-silenced') throw new Error('Unknown A2A notification capability mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
  name: 'a2a-notification-capability-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    let code = source
    if (mutation && file === resolve(root, 'packages/core/src/client.ts')) {
      const before = 'if (!provider.prepareNativeInput) throw new AgentMuxError('
      if (source.split(before).length !== 2) throw new Error('Missing-transport mutation must match one actual Core guard')
      code = source.replace(before, 'if (false) throw new AgentMuxError(')
    }
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_NOTIFICATION_CAPABILITY_LOADED) appendFileSync(process.env.AGENTMUX_NOTIFICATION_CAPABILITY_LOADED,
      JSON.stringify({ path: relative(root, file), original: hash(readFileSync(file)), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}],
  test: { ...base.test, environment: 'node', include: ['packages/core/test/a2a-notification-capability.test.ts'] }
})
