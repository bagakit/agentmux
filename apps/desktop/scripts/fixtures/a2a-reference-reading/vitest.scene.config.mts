import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import base from '../../../test/vitest.a2a-message-metadata.config.mts'
import { candidateAlias } from '../../candidate-package-resolve.mjs'

// Follow this checkout's package exports, including newly moved Host-owned DTOs.
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...base, resolve: { ...base.resolve,
  alias: [candidateAlias(root, { source: true }), ...base.resolve.alias] } })
