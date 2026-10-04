import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// Mutation copies share the installed PDF.js package through a dependency symlink.
// Its real ?url worker resource must remain readable by Vite's actual asset loader.
const pdfjs = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
export default defineConfig({
  server: { fs: { allow: [process.cwd(), pdfjs] } },
  test: { include: ['apps/desktop/test/pdf-{content,engine,search-outline-engine}.test.{ts,tsx}'] }
})
