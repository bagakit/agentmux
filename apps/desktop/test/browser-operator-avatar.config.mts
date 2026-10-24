import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../scripts/fixtures/settings-overview/vitest.config.mts'
const root = resolve(import.meta.dirname, '../../..'), client = resolve(root, 'packages/client-ui')
const exports = JSON.parse(readFileSync(resolve(client, 'package.json'), 'utf8')).exports
const aliases = Object.entries(exports).sort(([left], [right]) => right.length - left.length).flatMap(([key, spec]) => {
  const target = typeof spec === 'string' ? spec : (spec as { browser?: string }).browser
  if (!target?.startsWith('./src/')) return []
  const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)')
  return [{ find: new RegExp(`^${pattern}$`), replacement: resolve(client, target).replace('*', '$1') }]
})
const owner = 'apps/desktop/src/renderer/src/lib/browser-operator-avatar.tsx'
const face = 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx'
const artwork = 'packages/client-ui/src/components/AgentAvatarStaticArtwork.tsx'
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'lose-enamel': { file: artwork, from: "<g {...(appearance?.tint ? { filter: `url(#${filterId})` } : {})}>", to: '<g>' },
  'lose-inline-raster': { file: owner, from: "image.setAttribute('href', dataUrl)", to: "image.setAttribute('href', source!)" },
  'lose-theme-key': { file: owner, from: 'return artwork(input).key', to: "return 'same-avatar-for-every-theme'" },
  'lose-byte-limit': { file: owner, from: 'const MAX_PNG_BYTES = 64 * 1024', to: 'const MAX_PNG_BYTES = 128 * 1024' }
}
const consumed = [owner, face, artwork, 'packages/client-ui/src/components/AgentProviderIcon.tsx', 'packages/client-ui/src/components/AgentEnamelFilter.tsx']
const proof = {
  name: 'bounded-original-avatar-artwork', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!consumed.includes(file)) return
    const selected = process.env.AGENTMUX_AVATAR_MUTATION
    const edit = selected ? mutations[selected] : undefined
    if (selected && !edit) throw new Error('Unknown static avatar mutation')
    let output = source
    if (edit?.file === file) {
      if (source.split(edit.from).length !== 2) throw new Error('Static avatar mutation must match exactly once')
      output = source.replace(edit.from, edit.to)
    }
    if (process.env.AGENTMUX_AVATAR_LOADED) appendFileSync(process.env.AGENTMUX_AVATAR_LOADED,
      JSON.stringify({ file, sourceSha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(output).digest('hex'), mutation: output === source ? null : selected }) + '\n')
    return output === source ? undefined : output
  }
}

// Consume this checkout's real artwork without building or writing shared dist.
export default defineConfig({ ...base, cacheDir: `.cache/browser-operator-avatar-${process.env.AGENTMUX_AVATAR_MUTATION ?? 'baseline'}`, plugins: [...base.plugins ?? [], proof], resolve: { ...base.resolve, alias: [...aliases, ...base.resolve!.alias as []] },
  test: { ...base.test, include: ['apps/desktop/test/browser-operator-avatar.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
