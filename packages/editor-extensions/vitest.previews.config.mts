import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../..')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 plugins: [{name:'packaged-preview-consumer-mutation',enforce:'pre',transform(source,id){
  if(process.env.EDITOR_PREVIEW_MUTATION!=='stale-diagram' || id!==resolve(import.meta.dirname,'src/ui/DiagramFilePreview.tsx')) return
  const needle='if (!current || value.id !== id) return'
  assert.equal(source.split(needle).length-1,1)
  if(process.env.EDITOR_PREVIEW_HITS)appendFileSync(process.env.EDITOR_PREVIEW_HITS,id+'\n')
  return {code:source.replace(needle,'if (value.id !== id) return'),map:null}
 }}],
 test:{passWithNoTests:false,setupFiles:[resolve(root,'vitest.setup.ts')],include:[
  'apps/desktop/test/media-player.test.tsx','apps/desktop/test/diagram-file-preview.test.tsx',
  'apps/desktop/test/plantuml-preview.test.tsx','apps/desktop/test/drawio-preview.test.ts',
  'apps/desktop/test/excalidraw-preview.test.tsx','apps/desktop/test/vega-preview-lifecycle.test.tsx',
  'apps/desktop/test/vega-preview.test.ts','apps/desktop/test/notebook-file-preview-component.test.tsx',
  'apps/desktop/test/structured-data-preview-component.test.tsx','apps/desktop/test/file-format-integration.test.tsx',
  'apps/desktop/test/file-build-controller.test.tsx',
  'apps/desktop/test/excalidraw-local-fonts.test.ts','apps/desktop/test/pdfjs-viewer-assets.test.ts'
 ]}
})
