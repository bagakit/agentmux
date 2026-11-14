import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/scripts/runtime-application-payload.mjs'
const mutation = process.env.PACKAGE_EXTENSION_MUTATION ? JSON.parse(process.env.PACKAGE_EXTENSION_MUTATION) : null
export default defineConfig({ root, plugins: [{
  name: 'packaged-extension-dependency-owner', enforce: 'pre', transform(source, id) {
    if (relative(root, id.split('?')[0]!) !== owner) return
    const sha = (text: string) => createHash('sha256').update(text).digest('hex'), originalSHA256 = sha(source)
    if (mutation) {
      if (source.split(mutation.anchor).length !== 2) throw new Error('Exactly one original dependency selection must be changed')
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    const output = process.env.PACKAGE_EXTENSION_LOADED
    if (!output) return source
    appendFileSync(output, '')
    const row = { path: owner, originalSHA256, loadedSHA256: sha(source), ...(mutation ? { mutant: mutation.id } : {}) }
    return `import {appendFileSync as __extensionLoaded} from 'node:fs'; __extensionLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { include: ['apps/desktop/test/package-extension-runtime.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 60_000 } })
