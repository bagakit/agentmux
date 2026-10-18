import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_USER_CARD_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'drop-feishu-user-card': { path: 'packages/connectors/src/adapters/feishu/publication.ts', before: "human = authors.length > 0 && authors.every(kind => kind === 'human')", after: 'human = false' },
  'drop-discord-user-card': { path: 'packages/connectors/src/adapters/discord/render.ts', before: "human = !!authors?.length && authors.every(kind => kind === 'human')", after: 'human = false' },
  'drop-feishu-input-status': { path: 'packages/connectors/src/adapters/feishu/publication.ts', before: 'const input = human ? operation.payload.inputSubmission : undefined', after: 'const input = undefined' },
  'drop-discord-input-status': { path: 'packages/connectors/src/adapters/discord/render.ts', before: "const input = human && p.kind === 'speech' ? p.inputSubmission : undefined", after: 'const input = undefined' },
  'drop-desktop-human': { path: 'apps/desktop/src/main/ipc.ts', before: 'return await args.runtime.submitPrompt(session, prompt, operationId, condition, undefined, choice, authorHuman, agentMuxNote, sourceChannel, inputContextCapture)', after: 'return await args.runtime.submitPrompt(session, prompt, operationId, condition, undefined, choice, false, agentMuxNote, sourceChannel, inputContextCapture)' },
  'drop-mobile-human': { path: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'prompt: expandSemanticReferences(original.draft), authorHuman: true,', after: 'prompt: expandSemanticReferences(original.draft), authorHuman: false,' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown User card mutation')
const marker = process.env.AGENTMUX_USER_CARD_LOADED
const connectorDependency = createRequire(resolve(root, 'packages/connectors/package.json'))
// Every affected Core/Channel owner is resolved to source. Runtime markers below
// prove execution; a stale dist package cannot stand in for this candidate.
export default defineConfig({ root, cacheDir: resolve(root, '.cache/user-cards'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: ['@larksuiteoapi/node-sdk', '@discordjs/rest'].map(find => ({ find, replacement: connectorDependency.resolve(find) })) },
  plugins: [{ name: 'loaded-native-user-card', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|mobile)\/src\/|packages\/(?:connectors|core)\/src\/)/u.test(path) || !/\.[cm]?[jt]sx?$/u.test(path)) return
    let output = input
    const selected = mutant ? mutations[mutant] : undefined
    if (selected?.path === path) {
      if (input.split(selected.before).length !== 2) throw Error('User card mutation owner changed')
      output = input.replace(selected.before, selected.after)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : mutant })
    return { code: "import { appendFileSync as __markUserCard } from 'node:fs'; __markUserCard(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  }, resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/') || source.startsWith('@agentmux/connectors/')) {
      const pkg = source.startsWith('@agentmux/core/') ? 'core' : 'connectors'
      const exports = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice(('@agentmux/' + pkg + '/').length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages', pkg, 'src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  } }], test: { environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/connectors/test/user-card-authors.test.ts', 'apps/desktop/test/channel-user-card-consumer.test.tsx', 'packages/connectors/test/desktop-codex-relay-consumer.test.ts'] }
})
