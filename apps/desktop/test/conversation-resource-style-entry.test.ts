import { resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'

it.each(['packages/client-ui/src/styles/index.css', 'apps/desktop/src/renderer/src/styles/index.css'])(
  'the actual stylesheet entry %s generates the readable resource controls', async entry => {
    const result = await build({ configFile: false, logLevel: 'error',
      build: { write: false, rollupOptions: { input: resolve(entry) } } })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => 'output' in bundle ? bundle.output : [])
    const css = outputs.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')).map(file => String(file.source)).join('\n')
    expect(css.length).toBeGreaterThan(0)
    expect(css).toContain('.conversation-resource-text__controls')
    expect(css).toContain('.conversation-resource-text__error')
  })
