import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, plugins: [{
  name: 'omit-packaged-protobuf', enforce: 'pre', transform(source, id) {
    if (!process.env.PACKAGE_PROTOBUF_OMIT || id !== resolve(root, 'apps/desktop/scripts/runtime-application-payload.mjs')) return
    const anchor = "'@bufbuild/protobuf', "
    if (source.split(anchor).length !== 2) throw new Error('Expected exactly one production protobuf selection')
    return source.replace(anchor, '')
  }
}], test: { include: ['apps/desktop/test/package-protobuf-runtime.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
