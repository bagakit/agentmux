import { defineConfig, mergeConfig } from 'vite'
import base from '../../../vite.web.config'
import { resolve } from 'node:path'
export default mergeConfig(base, defineConfig({ root: import.meta.dirname,
  server: { port: 4279, fs: { allow: [resolve(import.meta.dirname, '../../../../..')] } } }))
