import { defineConfig } from 'vitest/config'
import base from './vitest.mote-creator-reply.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...base, plugins: [...base.plugins!, { name: 'original-chat-name-discovery', enforce: 'pre', transform(code, id) {
  const file = relative(base.root!, id.split('?')[0]!)
  if (!['packages/connectors/src/mote-chat.ts', 'packages/core/src/agent-outbound-message.ts'].includes(file)) return
  let loaded = code
  if (process.env.MOTE_CHAT_NAME_MUTANT === 'disconnect' && file === 'packages/core/src/agent-outbound-message.ts') {
    const before = '    if (!injectAgentMuxGuide && (userRequest || parts.length > 0) && !parts.includes(AGENTMUX_SESSION_NAMING_ENTRY)) parts.unshift(AGENTMUX_SESSION_NAMING_ENTRY)'
    if (code.split(before).length !== 2) throw Error('General naming source anchor changed')
    loaded = code.replace(before, '')
  }
  if (process.env.MOTE_CHAT_NAME_LOADED) appendFileSync(process.env.MOTE_CHAT_NAME_LOADED, JSON.stringify({ file, sourceSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === code ? null : { code: loaded, map: null }
} }], test: { ...base.test, include: ['packages/connectors/test/mote-chat-task-naming.integration.test.ts'], maxWorkers: 1, passWithNoTests: false } })
