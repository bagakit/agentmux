import { defineConfig } from 'vitest/config'
import owning from './renderer-v8-profile.config.mts'

export default defineConfig({ ...owning,
  test: { ...owning.test, include: ['apps/desktop/test/renderer-v8-profile-routing.test.ts'], environment: 'happy-dom' }
})
