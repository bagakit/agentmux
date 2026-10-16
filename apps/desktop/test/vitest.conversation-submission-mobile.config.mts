import reading from './vitest.conversation-submission-reading.config.mts'
import mobile from './vitest.conversation-mobile-consumers.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...reading, resolve: mobile.resolve, ssr: mobile.ssr, cacheDir: '.cache/conversation-submission-mobile',
  test: { ...reading.test, include: ['apps/mobile/test/conversation-protocol-consumer.test.tsx'], name: 'shared-submission-mobile', testNamePattern: /^authenticated Mobile shows submission activity/,  passWithNoTests: false } })
