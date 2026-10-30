import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.user-cards.config.mts'
const dependency = createRequire(resolve(import.meta.dirname, '../package.json'))
const cjs = dependency.resolve('@larksuiteoapi/node-sdk')
const entry = process.env.RECEIVER_SDK_ENTRY ?? (process.env.RECEIVER_SDK_FORMAT === 'esm' ? resolve(dirname(cjs), '../es/index.js') : cjs)
export default defineConfig({ ...original, cacheDir: resolve(import.meta.dirname, '../../../.cache/sdk-short-ping'),
  define: { ...original.define, __RECEIVER_SDK_ENTRY__: JSON.stringify(entry) },
  plugins: [...original.plugins ?? [], { name: 'loaded-native-sdk-entry', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== entry || !process.env.RECEIVER_SDK_LOADED) return
    const row = JSON.stringify({ entry, sha256: createHash('sha256').update(source).digest('hex'), format: process.env.RECEIVER_SDK_FORMAT ?? 'cjs', executed: true }) + '\n'
    return { code: "import {appendFileSync as __sdkMark} from 'node:fs'; __sdkMark(" + JSON.stringify(process.env.RECEIVER_SDK_LOADED) + ',' + JSON.stringify(row) + ');\n' + source, map: null }
  } }],
  resolve: { alias: [{ find: '@larksuiteoapi/node-sdk', replacement: entry }] },
  test: { ...original.test, include: ['packages/connectors/test/sdk-short-ping-consumer.test.ts'], testTimeout: 25000, passWithNoTests: false }
})
