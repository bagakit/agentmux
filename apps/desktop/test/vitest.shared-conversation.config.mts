import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../../packages/connectors/test/vitest.user-cards.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_SHARED_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'drop-cross-channel': ['packages/connectors/src/publication-content.ts', 'const external = original.kind === \'captured\' ? original.item.authorExternal : undefined', 'if (original.kind === \'captured\' && original.item.authorExternal) continue\n    const external = original.kind === \'captured\' ? original.item.authorExternal : undefined']
}
if (mutation && !mutations[mutation]) throw Error('Unknown shared conversation mutation')
export default defineConfig({ ...source, cacheDir: resolve(root, '.cache/shared-conversation'),
  plugins: source.plugins!.map((plugin: any) => ({ ...plugin, name: 'shared-conversation-actual-owners', transform(input: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|host|mobile)\/src\/|packages\/(?:connectors|core)\/src\/)/u.test(path) || !/\.[cm]?[jt]sx?$/u.test(path)) return
    const selected = mutation ? mutations[mutation] : null
    let code = input
    if (selected?.[0] === path) {
      if (input.split(selected[1]).length !== 2) throw Error('Shared conversation mutation must match one actual owner')
      code = input.replace(selected[1], selected[2])
    }
    const marker = process.env.AGENTMUX_SHARED_LOADED
    if (!marker) return input === code ? undefined : { code, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(code), mutation: input === code ? null : mutation })
    return { code: "import { appendFileSync as __sharedLoaded } from 'node:fs'; __sharedLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + code, map: null }
  } })), test: { ...source.test, include: ['apps/desktop/test/shared-conversation-consumer.test.tsx', 'apps/desktop/test/shared-conversation-settings.test.tsx'], testTimeout: 45_000 } })
