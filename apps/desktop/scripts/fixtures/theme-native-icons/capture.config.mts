import { defineConfig, mergeConfig } from 'vite'
import config from './vite.config.mts'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const mutant = process.env.NATIVE_ICON_MUTANT
const inputs: Record<string, {source: string, transformed: string}> = {}
export default mergeConfig(config, defineConfig({ worker: { format: 'es' }, plugins: [{ name: 'native-proof-inputs', enforce: 'pre',
  transform(code, id) {
    const original = code
    if (mutant === 'portal' && id.endsWith('/lib/excalidraw-icons.ts')) {
      const target = '[...controls, ...EXCALIDRAW_PORTAL_ICONS]'
      if (code.split(target).length !== 2) throw new Error('Expected one production portal adapter edge.')
      code = code.replace(target, 'controls')
    } else if (mutant && id.endsWith(`/lib/${mutant}-icons.ts`)) {
      const target = 'iconShapes(semantic, theme.value.icons)'
      if (code.split(target).length !== 2) throw new Error('Expected exact production native icon override edges.')
      code = code.replaceAll(target, 'iconShapes(semantic, {})')
    }
    if (!id.includes('node_modules') && !id.startsWith('\0')) inputs[id] = {
      source: createHash('sha256').update(original).digest('hex'), transformed: createHash('sha256').update(code).digest('hex') }
    return { code, map: null }
  }, generateBundle() { this.emitFile({type: 'asset', fileName: 'candidate-inputs.json', source: JSON.stringify({mutant: mutant ?? null, capturedAt: new Date().toISOString(), preview: true, inputs}, null, 2)}) }
}], build: {target: 'esnext', outDir: resolve(process.env.NATIVE_ICON_PROOF_DIR ?? resolve(import.meta.dirname, '../../../../../.tmp/theme-system/native-icons'), mutant ? `site-${mutant}-mutant` : 'site'), emptyOutDir: true,
  rollupOptions: {input: {native: resolve(import.meta.dirname, 'index.html'), mobile: resolve(import.meta.dirname, 'mobile.html')}}} }))
