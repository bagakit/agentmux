import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './connection-owner-consumer.config.mts'

const root = original.root!, marker = process.env.STATIC_AVATAR_LOADED, mutant = process.env.STATIC_AVATAR_MUTANT
const mutations = {
  mote: ['apps/host/src/mote-avatar-read.ts', 'const drawing = savedMoteAvatarDrawing(snapshot.choice, appearance)', 'const drawing = undefined'],
  executor: ['apps/host/src/static-avatar.ts', 'agentAvatarSvg(providerId, saved, bundledRaster', 'agentAvatarSvg(providerId, undefined, bundledRaster'],
  cancellation: ['apps/host/src/static-avatar.ts', 'signal ? AbortSignal.any([signal]) : undefined', 'signal']
} as const
if (mutant && !(mutant in mutations)) throw Error('Unknown static portrait mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/static-avatar'), plugins: [{
  name: 'original-static-avatar-artwork', enforce: 'pre', resolveId(source) {
    if (source === '@agentmux/client-ui/theme') return resolve(root, 'packages/client-ui/src/theme/index.ts')
    if (source.startsWith('@agentmux/client-ui/note/')) return resolve(root, 'packages/client-ui/src/note', source.slice('@agentmux/client-ui/note/'.length) + '.ts')
    if (source.startsWith('@agentmux/client-ui/components/')) return resolve(root, 'packages/client-ui/src/components', source.slice('@agentmux/client-ui/components/'.length) + '.tsx')
    if (source.startsWith('@agentmux/client-ui/')) return resolve(root, 'packages/client-ui/src/lib', source.slice('@agentmux/client-ui/'.length) + '.ts')
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:client-ui|connectors|core))\/(?:src|test)\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let code = source
    const selected = mutations[mutant as keyof typeof mutations]
    if (selected?.[0] === path) {
      if (source.split(selected[1]).length !== 2) throw Error('Static portrait mutation requires one original owner')
      code = source.replace(selected[1], selected[2])
    }
    if (!marker) return source === code ? undefined : { code, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, sourceSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutant })
    return { code: "import { appendFileSync as __staticAvatarLoaded } from 'node:fs'; __staticAvatarLoaded(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + code, map: null }
  }
}, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/static-avatar.test.ts',
  'apps/host/test/publication-speaker-consumer.test.ts', 'apps/host/test/mote-avatar-read-consumer.test.ts'], testTimeout: 40_000 } })
