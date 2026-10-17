import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './browser-operator-avatar.config.mts'

const edits: Record<string, [string, string]> = {
  'lose-native-decode': ['nativeImageFromBrowserPng(image, value => nativeImage.createFromBuffer(value))', 'void image'],
  'lose-geometry': ['if (image.width !== 64 || image.height !== 64)', 'if (false)'],
  'lose-byte-limit': ['const MAX_BYTES = 64 * 1024', 'const MAX_BYTES = 128 * 1024']
}
const proof = { name: 'bounded-native-avatar-validation', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (!id.endsWith('/src/main/browser-operator-avatar.ts')) return
    const selected = process.env.AGENTMUX_AVATAR_BRIDGE_MUTATION
    let output = source
    if (selected) {
      const edit = edits[selected]
      if (!edit || source.split(edit[0]).length !== 2) throw new Error('The native avatar mutation must match exactly once')
      output = source.replace(...edit)
    }
    if (process.env.AGENTMUX_AVATAR_BRIDGE_LOADED) appendFileSync(process.env.AGENTMUX_AVATAR_BRIDGE_LOADED,
      JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(output).digest('hex'), mutation: selected ?? null }) + '\n')
    return output === source ? undefined : output
  } }
export default defineConfig({ ...base, cacheDir: `.cache/browser-operator-avatar-bridge-${process.env.AGENTMUX_AVATAR_BRIDGE_MUTATION ?? 'baseline'}`,
  plugins: [...base.plugins ?? [], proof],
  test: { ...base.test, include: ['apps/desktop/test/browser-operator-avatar-validation.test.ts'] } })
