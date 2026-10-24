import { defineConfig } from 'vitest/config'
import native from './vitest.channel-join.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const changes = {
  scope: ['packages/core/src/room-binding-codec.ts', "if (input.scope.publication !== 'future-shared-conversation') fail()", 'if (false) fail()'],
  human: ['packages/core/src/client.ts', "if (source.kind === 'prompt' && source.authorHuman === true && key.kind === 'prompt') {", "if (source.kind === 'prompt' && false && key.kind === 'prompt') {"],
  confirmation: ['apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx', 'onClick={() => bind(true)}', 'onClick={() => {}}']
} as const
const mutation = process.env.COMPLETE_SHARING_MUTANT
if (mutation && !(mutation in changes)) throw Error('Unknown complete sharing mutation')
export default defineConfig({ ...native, cacheDir: '.cache/complete-sharing', define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [...native.plugins!, {
  name: 'complete-sharing-loaded-source', enforce: 'pre', transform(original, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path) && !/^apps\/desktop\/src\/.+\.tsx?$/u.test(path)) return
    const change = mutation ? changes[mutation as keyof typeof changes] : undefined
    let code = original
    if (change?.[0] === path) {
      if (code.split(change[1]).length !== 2) throw Error('Complete sharing mutation must load exactly once')
      code = code.replace(change[1], change[2])
    }
    if (process.env.COMPLETE_SHARING_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.COMPLETE_SHARING_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), ...(code !== original ? { mutation } : {}) }) + '\n')
    }
    return code === original ? undefined : code
  },
  resolveId(source) {
    if (source.startsWith('@agentmux/host/')) return resolve(native.root!, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts')
    if (source.startsWith('@agentmux/client-ui/components/')) return resolve(native.root!, 'packages/client-ui/src/components', source.slice('@agentmux/client-ui/components/'.length) + '.tsx')
  }
}], test: { ...native.test, setupFiles: ['vitest.setup.ts'], include: ['packages/core/test/group-binding-sharing.test.ts', 'packages/connectors/test/group-conversation-completeness-consumer.test.ts', 'apps/desktop/test/complete-group-sharing.test.tsx', 'packages/connectors/test/mote-chat-first-input.integration.test.ts'], testTimeout: 30_000 } })
