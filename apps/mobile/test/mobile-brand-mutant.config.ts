import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { mobileBrandMutations, mobileBrandOwners } from './mobile-brand-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOBILE_BRAND_MUTATION, report = process.env.MOBILE_BRAND_LOADED
if (mutation && !Object.hasOwn(mobileBrandMutations, mutation)) throw Error('Unknown mobile brand mutation: ' + mutation)
const variant = mutation ? mobileBrandMutations[mutation as keyof typeof mobileBrandMutations] : undefined
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const recorded = new Set(mobileBrandOwners)
export default defineConfig({
  cacheDir: resolve(root, '.tmp/mobile-brand', mutation ?? 'baseline'),
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  plugins: [react(), { name: 'loaded-mobile-brand-owner', enforce: 'pre', transform(original, id) {
    const source = id.split('?')[0]!, path = relative(root, source)
    if (!recorded.has(path)) return
    let code = original
    if (variant?.file === path) {
      if (code.split(variant.before).length !== 2) throw Error('Production mutation must match exactly once: ' + mutation)
      code = code.replace(variant.before, variant.after)
    }
    if (report) appendFileSync(report, JSON.stringify({ path, originalSHA256: sha(readFileSync(source, 'utf8')), loadedSHA256: sha(code), mutation: variant?.file === path ? mutation : null }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { setupFiles: ['test/device-locks.ts'], environment: 'happy-dom', restoreMocks: true,
    include: ['test/mobile-goal-owner.test.tsx'], testNamePattern: variant?.target ?? 'mobile brand ',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
