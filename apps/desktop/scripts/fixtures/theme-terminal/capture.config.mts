import { defineConfig, mergeConfig } from 'vite'
import base from '../../../vite.web.config'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileDiagramAssets } from '../../../scripts/file-diagram-assets'
const inputs: Record<string, { source: string, transformed: string }> = {}
const mutant = process.env.TERMINAL_THEME_MUTANT
export default mergeConfig(base, defineConfig({ root: import.meta.dirname, worker: { format: 'es' }, resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: resolve(import.meta.dirname, 'xterm-instrumented.ts') }] },
  plugins: [fileDiagramAssets(resolve(import.meta.dirname, '../../..')), { name: 'terminal-theme-source-binding', enforce: 'pre', transform(code, id) {
    const original = code
    if (id.endsWith('/components/TerminalView.tsx')) {
      if (mutant === 'disconnected') code = code.replace('terminalRef.current.options.theme = terminalTheme(themeId)', 'terminalRef.current.options.theme = terminalTheme(\'graphite\')')
      if (mutant === 'search-icons') {
        const target = "icon: 'editor.match-case'"
        if (code.split(target).length !== 2) throw Error('Expected one original search semantic edge')
        code = code.replace(target, "icon: 'object.keyboard'")
      }
      if (mutant === 'recreated') {
        const target = '[session.control.run.runId, session.id])'
        if (code.split(target).length !== 2) throw new Error('Expected one attach lifetime edge')
        code = code.replace(target, '[session.control.run.runId, session.id, themeId])')
      }
      if (mutant && original === code) throw new Error('Production terminal mutation did not apply')
    }
    if (!id.includes('node_modules') && !id.startsWith('\0')) inputs[id] = { source: createHash('sha256').update(original).digest('hex'), transformed: createHash('sha256').update(code).digest('hex') }
    return { code, map: null }
  }, generateBundle() { this.emitFile({ type: 'asset', fileName: 'candidate-inputs.json', source: JSON.stringify({ mutant: mutant ?? null, inputs }, null, 2) }) } }],
  build: { target: 'esnext', minify: false, outDir: resolve(process.env.NATIVE_COLOR_PROOF_DIR!, mutant ? `terminal-${mutant}-mutant` : 'terminal-site'), emptyOutDir: true }
}))
