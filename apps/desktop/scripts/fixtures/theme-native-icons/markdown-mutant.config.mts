import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../../packages/client-ui/vitest.config'
export default mergeConfig(base, defineConfig({ plugins: [{ name: 'image-reference-consumer-mutant', enforce: 'pre', transform(code,id) {
  if(id.endsWith('/components/AgentMarkdown.tsx')) {
    const before = "semanticIconComponent('object.image')"
    if(code.split(before).length!==2)throw new Error('Expected exact image reference consumer')
    return code.replace(before,"semanticIconComponent('object.file')")
  }
} }],test:{include:['packages/client-ui/test/markdown-image-icon.test.tsx']} }))
