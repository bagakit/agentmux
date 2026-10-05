import { defineConfig, mergeConfig } from 'vite'
import base from '../../../vite.web.config'
import { resolve } from 'node:path'
import { fileDiagramAssets } from '../../../scripts/file-diagram-assets'
export default mergeConfig(base, defineConfig({ root: import.meta.dirname,
  plugins: [fileDiagramAssets(resolve(import.meta.dirname, '../../..'))],
  server: { port: 4286, fs: { allow: [resolve(import.meta.dirname, '../../../../..')] } } }))
