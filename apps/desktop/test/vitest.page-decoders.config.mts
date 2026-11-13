import { defineConfig } from 'vitest/config'
import { pageDecoderMutation } from '../../../packages/editor-extensions/scripts/page-decoder-mutations.mjs'
export default defineConfig({ plugins: pageDecoderMutation(process.env.PAGE_DECODER_MUTATION, process.env.PAGE_DECODER_HITS), test: { include: ['apps/desktop/test/workspace-cbr-archives.test.ts', 'packages/editor-extensions/test/page-book.test.ts'], passWithNoTests: false } })
