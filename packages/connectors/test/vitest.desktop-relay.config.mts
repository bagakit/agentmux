import { defineConfig, defaultExclude } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CHANNEL_IPC_MUTATION
const marker = process.env.CHANNEL_IPC_LOADED
const changes: Record<string, [string, string, string]> = {
 'drop-trusted-human': ['apps/desktop/src/main/ipc.ts', 'effectiveAuthorHuman = true', 'effectiveAuthorHuman = false'],
 'drop-public-writer': ['packages/core/dist/client.js', "title, message.userContent, now, 'user', { status, publicContent: 'confirmed'", "title, message.userContent, now, 'user', { status"]
}
if (mutation && !changes[mutation]) throw Error('Unknown native speech mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/channel-desktop-relay'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 plugins: [{ name: 'original-ipc-relay-mutation', enforce: 'pre', transform(original, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!Object.values(changes).some(([owner]) => owner === path)) return
  let source = original
  const selected = mutation ? changes[mutation] : null
  if (selected?.[0] === path) {
   if (source.split(selected[1]).length !== 2) throw Error('Original input qualification owner changed')
   source = source.replace(selected[1], selected[2])
  }
  const hash = (v: string) => createHash('sha256').update(v).digest('hex')
  const row = JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(source), mutation: source === original ? null : mutation })
  if (!marker) return source === original ? undefined : { code: source, map: null }
  return { code: "import { appendFileSync as __markChannelIpc } from 'node:fs'; __markChannelIpc(" + JSON.stringify(marker) + ", " + JSON.stringify(row + '\n') + ");\n" + source, map: null }
 } }],
 test: { include: ['packages/connectors/test/desktop-codex-relay-consumer.test.ts'], exclude: defaultExclude, setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1 } })
