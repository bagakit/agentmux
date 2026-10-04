import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import owning from '../../../../desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'

const repository = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_MOBILE_ATTACHMENTS_MUTANT ? JSON.parse(process.env.AGENTMUX_MOBILE_ATTACHMENTS_MUTANT) as { file: string; before: string; after: string } : undefined
export default defineConfig({
  root: resolve(repository, 'apps/mobile'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [react(), { name: 'mobile-attachments-source-proof', enforce: 'pre', transform(code, id) {
    const path = id.split('?')[0]!, file = relative(repository, path), proof = process.env.AGENTMUX_MOBILE_ATTACHMENTS_PROOF
    const baseline = process.env.AGENTMUX_MOBILE_ATTACHMENTS_BASELINE
    if (baseline && /\.[cm]?[jt]sx?$/u.test(file) && !id.includes('?') && /^(packages\/|apps\/(mobile|desktop)\/)/.test(file)) {
      try { return execFileSync('git', ['show', baseline + ':' + file], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
      catch { /* New candidate-only files have no baseline representation. */ }
    }
    if (proof && /^(packages\/|apps\/(mobile\/src|desktop\/src\/main)\/)/.test(file)) appendFileSync(proof, JSON.stringify({ file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), consumer: 'actual-vite-module' }) + '\n')
    if (mutant && mutant.file === file) {
      if (code.split(mutant.before).length !== 2) throw new Error('One exact loaded mutant anchor is required')
      const changed = code.replace(mutant.before, mutant.after)
      if (proof) appendFileSync(proof, JSON.stringify({ file, consumer: 'actual-loaded-mutant', beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(changed).digest('hex') }) + '\n')
      return changed
    }
  } }],
  resolve: { ...owning.resolve, alias: [{ find: '@agentmux/relay/offer', replacement: resolve(repository, 'packages/relay/src/connection-offer.ts') }, ...owning.resolve!.alias as Array<{ find: RegExp; replacement: string }>], conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { environment: 'happy-dom', include: ['test/mobile-attachments.test.tsx', 'test/file-upload-public.test.ts', 'test/native-device.test.ts', 'test/device-workface.test.tsx', 'test/mobile-original-retry.test.tsx', 'test/mobile-send-capability.test.tsx', '../desktop/test/composer-file-reference.test.ts', '../desktop/test/composer-semantic-reference.test.tsx', '../desktop/test/inline-composer.test.tsx'], restoreMocks: true, passWithNoTests: false, maxWorkers: 1 }
})
