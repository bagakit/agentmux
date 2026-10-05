import { defineConfig, mergeConfig } from 'vite'
import config from './vite.config.mts'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const mutant = process.env.AGENTMUX_THEME_PROOF_MUTANT === 'app-selection'
const inputs: Record<string, string> = {}
export default mergeConfig(config, defineConfig({ worker: { format: 'es' }, plugins: [{ name: 'theme-proof-inputs', enforce: 'pre',
  transform(code, id) {
    if (mutant && id.endsWith('/src/renderer/src/App.tsx')) {
      const target = 'updateThemeSelection(config?.appearance ?? {})'
      if (code.split(target).length !== 2) throw new Error('Expected exactly one real App theme update edge.')
      code = code.replace(target, 'updateThemeSelection({})')
    }
    if (!id.includes('node_modules') && !id.startsWith('\\0')) inputs[id] = createHash('sha256').update(code).digest('hex'); return { code, map: null } },
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'candidate-inputs.json', source: JSON.stringify({ mutant: mutant ? 'app-selection' : null, capturedAt: new Date().toISOString(), preview: true, inputs }, null, 2) }) }
}], build: { target: 'esnext', outDir: resolve(import.meta.dirname, mutant ? '../../../../../.tmp/theme-system/site-mutant' : '../../../../../.tmp/theme-system/site'), emptyOutDir: true } }))
