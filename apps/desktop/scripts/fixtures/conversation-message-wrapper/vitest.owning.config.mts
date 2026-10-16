import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const alias = Object.entries(manifest.exports).flatMap(([name, value]) => {
  const source = resolve(root, 'packages/core/src/' + (value as { import: string }).import.replace('./dist/', '').replace(/\.js$/u, '.ts'))
  return existsSync(source) ? [{ find: name === '.' ? '@agentmux/core' : '@agentmux/core' + name.slice(1), replacement: source }] : []
}).sort((a, b) => b.find.length - a.find.length)
const edits: Record<string, [string, string, string]> = {
  'reminder-missing': ['packages/client-ui/src/components/ConversationInputText.tsx', '{prefix?.reminder ?', '{false ?'],
  'packet-plain': ['packages/client-ui/src/components/ConversationInputText.tsx', '{prefix?.packet ? prefix.packet.parts.map', '{false ? prefix!.packet!.parts.map'],
  'copy-body-only': ['packages/client-ui/src/components/ConversationMessage.tsx', ': copyText ?? complete.map(partText)', ': prefix?.body ?? copyText ?? complete.map(partText)'],
  'resource-nonleading': ['packages/client-ui/src/components/ConversationResourceText.tsx', 'inputMode && partIndex === 0 &&', 'inputMode &&'],
  'input-parser-missing': ['packages/client-ui/src/components/ConversationMessage.tsx', 'parseAgentMuxMessagePrefix(firstText) : null', 'null : null']
}
export default defineConfig({
  ...base, root, resolve: { conditions: ['browser', 'import', 'default'], alias },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  esbuild: { jsx: 'automatic' }, cacheDir: resolve(root, '.tmp/a2a-conversation-wrapper/cache', process.env.AGENTMUX_MESSAGE_WRAPPER_MUTATION ?? 'baseline'),
  plugins: [{ name: 'owned-wrapper-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const original = code, mutation = process.env.AGENTMUX_MESSAGE_WRAPPER_MUTATION, edit = mutation ? edits[mutation] : undefined
    if (edit && file === resolve(root, edit[0])) {
      if (code.split(edit[1]).length !== 2) throw Error('Unique mutation anchor missing: ' + mutation)
      code = code.replace(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_MESSAGE_WRAPPER_LOADED_SOURCE
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file), bytes: Buffer.byteLength(code), originalSHA256: createHash('sha256').update(readFileSync(file)).digest('hex'), compiledInputSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(code === original ? {} : { mutation }) }) + '\n') }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, globalSetup: [], // Every Core package export above is source; no stale package dist is consumed.
    environment: 'happy-dom', server: { deps: { inline: ['@agentmux/client-ui'] } }, include: process.env.AGENTMUX_MESSAGE_WRAPPER_ADJACENT === '1' ? [
      'packages/client-ui/test/conversation-leading-context.test.tsx',
      'packages/client-ui/test/conversation-long-message.test.tsx', 'packages/client-ui/test/conversation-detail-copy.test.tsx'
    ] : ['apps/desktop/test/conversation-message-wrapper.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
