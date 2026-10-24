import base from '../../../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
if (!process.env.AGENTMUX_PACKAGE_BOOTSTRAP_IDENTITY) throw new Error('Use verify-package-bootstrap.mjs to generate the original Identity runtime export.')
export default { ...base, root,
  resolve: { alias: [
    { find: /^@agentmux\/identity\/runtime-source$/, replacement: process.env.AGENTMUX_PACKAGE_BOOTSTRAP_IDENTITY },
    { find: '../../host/dist/macos-service.js', replacement: resolve(root, 'apps/host/src/macos-service.ts') },
    ...(base.resolve?.alias as any[] ?? [])
  ] },
  plugins: [{ name: 'package-bootstrap-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (process.env.AGENTMUX_PACKAGE_BOOTSTRAP_LOADED && /^(apps|packages)\//u.test(path))
      appendFileSync(process.env.AGENTMUX_PACKAGE_BOOTSTRAP_LOADED, JSON.stringify({ path, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  } }],
  test: { ...base.test, include: ['apps/desktop/test/package-install-workbench-continuity.test.ts',
    'apps/desktop/test/package-semantic-host-reload.test.ts', 'apps/desktop/test/package-smoke-ready-race.test.ts'],
    passWithNoTests: false, hookTimeout: 20_000, testTimeout: 20_000 }
}
