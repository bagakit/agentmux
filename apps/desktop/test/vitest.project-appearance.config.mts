import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const appearance = 'apps/desktop/src/main/project-appearance.ts', image = 'apps/desktop/src/main/project-icon-image.ts'
export const mutations = {
  'small-input-cap': [appearance, 'const MAX_ICON_BYTES = 1024 * 1024', 'const MAX_ICON_BYTES = 256 * 1024'],
  'unbounded-output': [image, 'output.length > PROJECT_ICON_OUTPUT_MAX_BYTES', 'false'],
  'unbounded-candidates': [appearance, 'const MAX_CANDIDATES = 128', 'const MAX_CANDIDATES = 1024'],
  'unbounded-probe-bytes': [appearance, 'const MAX_PROBE_BYTES = 4 * 1024 * 1024', 'const MAX_PROBE_BYTES = 8 * 1024 * 1024'],
  'filesystem-dependent-order': [appearance, 'entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)', 'void entries'],
  'hidden-tool-data': [appearance, "!entry.name.startsWith('.') && ", ''],
  'image-disconnected': [appearance, 'icon: hit?.icon ?? null', 'icon: null'],
  'ignore-encoded-size': [image, 'assertObjectAvatarSize(size)', 'void size'],
  'missing-decoder-wiring': ['apps/desktop/src/main/space-object-images.ts', 'projectAppearance(directory, this.createImage)', 'projectAppearance(directory, () => { throw Error("Decoder disconnected") })']
} as const
const selected = process.env.AGENTMUX_PROJECT_ICON_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown project icon mutation')
let applied = false
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/project-appearance-vitest-cache'),
  resolve: { alias: {
    '@agentmux/host/object-avatar-files': resolve(root, 'apps/host/src/object-avatar-files.ts'),
    '@agentmux/host/object-avatars': resolve(root, 'apps/host/src/object-avatars.ts'),
    '@agentmux/core/object-avatar': resolve(root, 'packages/core/src/object-avatar.ts'),
    '@agentmux/core/object-id': resolve(root, 'packages/core/src/object-id.ts'),
    '@agentmux/identity': resolve(root, 'packages/identity/src/index.ts')
  } },
  plugins: [{ name: 'actual-project-appearance-source', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (selected && file === mutations[selected][0]) {
      const [, before, after] = mutations[selected]
      if (code.split(before).length !== 2) throw Error('The unique project icon mutation anchor is missing')
      code = code.replace(before, after); applied = true
    }
    if (process.env.AGENTMUX_PROJECT_ICON_LOAD_LOG && [appearance, image, 'apps/desktop/src/main/space-object-images.ts'].includes(file))
      appendFileSync(process.env.AGENTMUX_PROJECT_ICON_LOAD_LOG, JSON.stringify({ file, sha256: createHash('sha256').update(code).digest('hex'), mutant: selected ?? null }) + '\n')
    return { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The owning project icon mutation was not loaded') } }],
  test: { environment: 'node', include: ['apps/desktop/test/project-appearance.test.ts'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
