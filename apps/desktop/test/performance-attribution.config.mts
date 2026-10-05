import base from '../../../vitest.config'
import { defineConfig } from 'vitest/config'
export default defineConfig({...base, resolve:{conditions:['browser','module','development|production']},esbuild:{jsx:'automatic'},test:{...base.test,include:['apps/desktop/test/performance-attribution.test.tsx'],maxWorkers:1}})
