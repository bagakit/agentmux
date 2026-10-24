import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/host/src/mobile-assets-owner.ts'
const mutants = {
  'snapshot-exchange': ['this.active = snapshot\n      this.retained', 'this.active = this.active\n      this.retained'],
  'operation-inspect': ['const receipt = input.operationId ? this.operations.get(input.operationId) ?? null : null', 'const receipt = null'],
} as const
const mutant = process.env.MOBILE_WEB_OWNER_MUTANT
if (mutant && !Object.hasOwn(mutants, mutant)) throw Error('Unknown mobile asset owner mutant')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({
  root,
  cacheDir: resolve(root, '.tmp/mobile-web-owner-test', mutant ?? 'normal'),
  plugins: [{ name: 'mobile-web-owner-proof', enforce: 'pre', transform(original, id) {
    if (id.split('?')[0] !== resolve(root, owner)) return
    let source = original
    if (mutant) {
      const [anchor, replacement] = mutants[mutant as keyof typeof mutants]
      if (source.split(anchor).length !== 2) throw Error('Owner mutant must match one actual production source')
      source = source.replace(anchor, replacement)
    }
    const report = process.env.MOBILE_WEB_OWNER_LOADED
    if (!report) throw Error('Owner proof requires its original loaded receipt path')
    const receipt = { path: owner, originalSHA256: hash(original), loadedSHA256: hash(source), mutant: mutant ?? null }
    // This write executes only when the transformed production module is evaluated.
    return "import { appendFileSync as __ownerProofLoaded } from 'node:fs'; __ownerProofLoaded(" +
      JSON.stringify(report) + ', JSON.stringify({... ' + JSON.stringify(receipt) + ',pid:process.pid})+"\\n");\n' + source
  } }],
  test: { include: ['apps/host/test/mobile-web-owner.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20_000 },
})
