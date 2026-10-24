import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  binary: ['native-desktop-package.mjs', "assert.equal(sha(bytes), sha(await readFile(executable(builtApp(root)))), 'Packaged native binary differs from the built candidate')", 'void 0'],
  profile: ['native-desktop-package.mjs', "assert.equal(receipt.profile, development ? 'bare-debug' : 'application')", 'void 0'],
  leaf: ['macos-signing.mjs', ' and certificate leaf = H"${plan.identity}"`)', '`)' ],
  bundle: ['native-desktop-package.mjs', 'bundleId: nativeBundleId', "bundleId: 'dev.agentmux.desktop'"]
} as const
const key = process.env.NATIVE_PACKAGE_MUTATION as keyof typeof mutations | undefined
if (key && !mutations[key]) throw new Error('Unknown native package mutation')
const mutation = key ? mutations[key] : null
export default defineConfig({ root,
  plugins: mutation ? [{ name: 'native-package-mutation', enforce: 'pre', load(id) {
    if (!id.endsWith('/apps/desktop/scripts/' + mutation[0])) return
    const source = readFileSync(id, 'utf8')
    // bundle has two original consumers: copy receipt and actual signature options. Mutate both.
    if (key !== 'bundle' && source.split(mutation[1]).length !== 2) throw new Error('Non-unique native package mutation')
    return source.replaceAll(mutation[1], mutation[2])
  } }] : [],
  test: { include: ['apps/desktop/test/{native-desktop-package,package-macos-signing}.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false }
})
