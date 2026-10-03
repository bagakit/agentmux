import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../../../..');
export default defineConfig({
  root,
  define: {
    __AGENTMUX_WEB_PREVIEW__: 'true'
  },
  resolve: {
    conditions: ['browser', 'import', 'default']
  },
  ssr: {
    noExternal: ['@agentmux/client-ui'],
    resolve: {
      conditions: ['browser', 'import', 'default']
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react'
  },
  cacheDir: resolve(root, '.question-test-cache'),
  plugins: [{
    name: 'question-source-binding',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!file.startsWith(root + '/apps/desktop/src/') && !file.startsWith(root + '/packages/client-ui/src/') && !file.startsWith(root + '/packages/core/dist/')) return;
      const out = process.env.QUESTION_UI_LOADED;
      if (out) appendFileSync(out, JSON.stringify({
        path: file.slice(root.length + 1),
        sha256: createHash('sha256').update(code).digest('hex'),
        bytes: Buffer.byteLength(code)
      }) + '\n');
    }
  }],
  test: {
    include: ['apps/desktop/test/conversation-async-question.integration.test.tsx', 'apps/desktop/test/session-pane-async-question.integration.test.tsx', 'apps/desktop/test/question-reply-ipc.integration.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    server: {
      deps: {
        inline: ['@agentmux/client-ui']
      }
    }
  }
});
