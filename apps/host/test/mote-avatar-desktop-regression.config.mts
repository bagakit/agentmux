import { defineConfig } from 'vitest/config'
import original from './mote-avatar-read-consumer.config.mts'

// The actual Core/Host owners use the same source resolution as the Node consumer.
// These existing Desktop cases retain their original native image boundary and assertions.
export default defineConfig({ ...original, test: { ...original.test,
  include: ['apps/desktop/test/mote-avatar-reuse.test.ts', 'apps/desktop/test/object-avatar-concurrent-save.test.ts'],
  testNamePattern: 'exports the current appearance|retains a real acknowledged immutable PNG|does not expose the formal hash file|preserves ordinary immutable|retains complete formal bytes|refuses an existing hash path',
  testTimeout: 25_000
} })
