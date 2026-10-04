import { defineConfig } from 'vitest/config'

// This foundation slice changes format dispatch, not startup/recovery. Its real CLI modes are the consumer.
export default defineConfig({ test: { testNamePattern: /File Region modes|lightweight File format/ } })
