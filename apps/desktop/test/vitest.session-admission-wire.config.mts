import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.SESSION_ADMISSION_WIRE_INVERSE ? JSON.parse(readFileSync(process.env.SESSION_ADMISSION_WIRE_INVERSE, 'utf8')) as { name: string; file: string; before: string; after: string } : undefined
export default defineConfig({ ...base, cacheDir: process.env.SESSION_ADMISSION_WIRE_CACHE ?? resolve(root, '.cache/session-admission-wire'),
  resolve: { ...base.resolve, alias: [{ find: /^@agentmux\/browser\/(.+)$/, replacement: resolve(root, 'packages/browser/src/$1.ts') },
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [...(base.plugins ?? []), { name: 'session-admission-wire-source-proof', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('apps/') && !path.startsWith('packages/')) || path.includes('/node_modules/')) return
    let source = original
    if (inverse?.file === path) {
      if (source.split(inverse.before).length !== 2) throw Error('Expected one exact original carrier inverse: ' + inverse.name)
      source = source.replace(inverse.before, inverse.after)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.SESSION_ADMISSION_WIRE_LOADED) appendFileSync(process.env.SESSION_ADMISSION_WIRE_LOADED,
      JSON.stringify({ path, sourceSHA256: hash(original), loadedSHA256: hash(source), mutation: source === original ? null : inverse!.name }) + '\n')
    return source === original ? undefined : { code: source, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/session-admission-wire.test.tsx'], passWithNoTests: false, testTimeout: 20000, hookTimeout: 20000 }
})
