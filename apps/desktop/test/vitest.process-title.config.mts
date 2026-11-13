import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repository = resolve(import.meta.dirname, '../../..')
if (process.platform !== 'darwin' || !process.env.PROCESS_IDENTITY_ELECTRON) {
  throw Error('This process identity consumer gate requires the exact signed macOS Electron executable')
}
export default defineConfig({
  plugins: [{ name: 'installer-original-process-identity', enforce: 'pre', transform(source, id) {
    const file = relative(repository, id.split('?')[0]!)
    if (file !== 'apps/desktop/scripts/package-process-scope.mjs') return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.PROCESS_TITLE_MUTANT
    const anchors = {
      'argv-mode-candidates': [
        " ||\n    previousOwners.some(owner => identityMatches(owner, row))", ''
      ],
      'argv-helper-gui': [
        "return boundModes.get(pid) === 'gui' ?",
        "if (selected.has(pid) && row.command.startsWith(bundle.helperRoot)) return [[pid, { source: 'bundle-helper' }]]; return boundModes.get(pid) === 'gui' ?"
      ],
      'argv-mode-binding': [
        "return ['node', 'gui'].includes(mode?.mode) && isBundleImage(mode.executable, bundle)",
        "return (row.command === bundle.executable || row.command.startsWith(`${bundle.executable} `)) && ['node', 'gui'].includes(mode?.mode) && isBundleImage(mode.executable, bundle)"
      ]
    }
    if (mutant) {
      const change = anchors[mutant as keyof typeof anchors]
      if (!change || source.split(change[0]!).length !== 2) throw Error('Select one exact original process identity mutation')
      source = source.replace(change[0]!, change[1]!)
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex'), report = process.env.PROCESS_TITLE_LOADED
    if (report) {
      const receipt = { file, pid: process.pid, originalSHA256, loadedSHA256, ...(mutant ? { mutant } : {}) }
      source = "import { appendFileSync as __identityLoaded } from 'node:fs'; __identityLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    }
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-process-scope.test.ts', 'apps/desktop/test/package-process-title.test.ts'],
    environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30_000 }
})
