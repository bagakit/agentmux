import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { mobileChromeMutations } from './mobile-chrome-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOBILE_CHROME_MUTATION, report = process.env.MOBILE_CHROME_LOADED
if (mutation && !Object.hasOwn(mobileChromeMutations, mutation)) throw Error('Unknown phone chrome mutation: ' + mutation)
const variant = mutation ? mobileChromeMutations[mutation as keyof typeof mobileChromeMutations] : undefined
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const recorded = new Set([...Object.values(mobileChromeMutations).map(entry => entry.file), 'apps/mobile/test/mobile-chrome.test.tsx'])

export default defineConfig({ cacheDir: resolve(root, '.tmp/mobile-chrome', mutation ?? 'baseline'),
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  plugins: [react(), { name: 'loaded-mobile-chrome-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!recorded.has(path)) return
    let code = original
    if (variant?.file === path) {
      if (code.split(variant.before).length !== 2) throw Error('Production mutation must match exactly once: ' + mutation)
      code = code.replace(variant.before, variant.after)
    }
    if (report) appendFileSync(report, JSON.stringify({ path, originalSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: sha(code),
      mutation: variant?.file === path ? mutation : null }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { setupFiles: ['test/device-locks.ts'], environment: 'happy-dom', restoreMocks: true, include: ['test/mobile-chrome.test.tsx'],
    ...(variant ? { testNamePattern: variant.target } : {}), passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
