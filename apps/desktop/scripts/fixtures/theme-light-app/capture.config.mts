import { defineConfig, mergeConfig } from 'vite'
import base from '../../../vite.web.config'
import { fileDiagramAssets } from '../../../scripts/file-diagram-assets'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const inputs: Record<string,string> = {}
const sourceRoot = process.env.APP_THEME_SOURCE_ROOT ?? resolve(import.meta.dirname, '../../../../..')
export default mergeConfig(base, defineConfig({ root: import.meta.dirname, worker: { format: 'es' },
  plugins: [{ name: 'app-theme-exact-source', enforce: 'pre', resolveId(source) {
    const packageName = ['@agentmux/client-ui', '@agentmux/core'].find(name => source === name || source.startsWith(name + '/'))
    if (!packageName) return
    const packagePath = packageName === '@agentmux/client-ui' ? 'packages/client-ui' : 'packages/core'
    const suffix = source === packageName ? '.' : './' + source.slice(packageName.length + 1)
    const exports = JSON.parse(readFileSync(resolve(sourceRoot, packagePath, 'package.json'), 'utf8')).exports
    let item = exports[suffix]
    if (!item) for (const key of Object.keys(exports).sort((a,b)=>b.length-a.length)) {
      if (!key.includes('*') || !suffix.startsWith(key.split('*')[0])) continue
      const value = exports[key], rest = suffix.slice(key.split('*')[0].length)
      item = typeof value === 'string' ? value.replace('*', rest) : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(v as string).replace('*',rest)]))
      break
    }
    if (!item) throw Error('Unmapped shared production entry ' + source)
    return resolve(sourceRoot, packagePath, typeof item === 'string' ? item : item.browser || item.import)
  } }, fileDiagramAssets(resolve(import.meta.dirname, '../../..')), { name: 'light-app-source-binding', enforce: 'pre', transform(code,id) {
    if (id.endsWith('/theme-light-app/entry.tsx')) code = code.replaceAll("'../../../src/", "'" + sourceRoot + '/apps/desktop/src/')
    if(!id.includes('node_modules')&&!id.startsWith('\0')) inputs[id] = createHash('sha256').update(code).digest('hex')
    return {code,map:null}
  }, generateBundle(){this.emitFile({type:'asset',fileName:'candidate-inputs.json',source:JSON.stringify({capturedAt:new Date().toISOString(),sourceRoot,inputs},null,2)})} }],
  build:{ target:'esnext',minify:false,outDir:resolve(process.env.NATIVE_COLOR_PROOF_DIR!,'app-site'),emptyOutDir:true }
}))
