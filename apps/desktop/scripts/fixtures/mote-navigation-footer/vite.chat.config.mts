import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import owning from './vitest.owning.config.mts'
export default defineConfig({
  root: import.meta.dirname, plugins: [react()], define: owning.define, resolve: owning.resolve,
  server: { host: '127.0.0.1', port: 4195, strictPort: true, fs: { allow: [new URL('../../../../..', import.meta.url).pathname] } }
})
