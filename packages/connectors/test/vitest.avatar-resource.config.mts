import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.native-portrait.config.mts'

export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/avatar-resource-completion') })
