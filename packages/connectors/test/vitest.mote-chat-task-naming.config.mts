import { defineConfig } from 'vitest/config'
import base from './vitest.mote-creator-reply.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
export default defineConfig({ ...base, plugins: [...base.plugins!, { name: 'original-chat-name-discovery', enforce: 'pre', transform(code, id) {
  const file = relative(base.root!, id.split('?')[0]!)
  if (file !== 'packages/connectors/src/mote-chat.ts') return
  let loaded = code
  if (process.env.MOTE_CHAT_NAME_MUTANT === 'disconnect') {
    const before = '        AGENTMUX_SESSION_NAMING_ENTRY,'
    if (code.split(before).length !== 2) throw Error('Chat naming source anchor changed')
    loaded = code.replace(before, '')
  }
  if (process.env.MOTE_CHAT_NAME_LOADED) appendFileSync(process.env.MOTE_CHAT_NAME_LOADED, JSON.stringify({ file, sourceSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === code ? null : { code: loaded, map: null }
} }], test: { ...base.test, include: ['packages/connectors/test/mote-chat-task-naming.integration.test.ts'], maxWorkers: 1, passWithNoTests: false } })
