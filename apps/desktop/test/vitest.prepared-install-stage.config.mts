import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repository = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  plugins: [{ name: 'prepared-install-stage-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(repository, id.split('?')[0]!)
    if (file !== 'apps/desktop/scripts/package-macos.mjs') return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.PACKAGE_STAGE_MUTANT
    const anchors = {
      'skip-stage-cleanup': ["await rm(next, { recursive: true })", '/* mutant leaves disposable stage */'],
      'ignore-source-change': ["sourceBefore && isDeepStrictEqual(sourceBefore, await signedSourceIdentity(appPath))", 'true'],
      'ignore-stage-change': ["ownedStage.identity && current.isDirectory() && !current.isSymbolicLink() && current.dev === ownedStage.identity.dev && current.ino === ownedStage.identity.ino", 'true'],
      'delete-cutover-stage': ["else if (cutoverStarted) cleanup", 'else if (false) cleanup'],
      'copy-retained-stage': ['if (preparedApplicationPath === null) {', 'if (true) {'],
      'skip-package-identity': ['assertPackageIdentity(await readPackageIdentity(next), await readPackageIdentity(appPath))', '/* mutant omits selected source identity */'],
      'skip-stage-name': ['stageName.startsWith(prefix) && /^[1-9]\\d*(?:-[a-f0-9-]{36})?\\.app$/.test(stageName.slice(prefix.length))', 'true'],
      'skip-stage-uid': ['stage.uid === process.getuid()', 'true'],
      'skip-canonical-object': ['installed.dev !== stage.dev || installed.ino !== stage.ino', 'true'],
      'skip-signed-bytes': ['stageHash === selectedHash', 'true'],
      'skip-retained-signature': ["await run('codesign', ['--verify', '--deep', '--strict', next], { capture: true })", '/* mutant omits stage signature verification */']
    }
    if (mutant) {
      const change = anchors[mutant as keyof typeof anchors]
      if (!change || source.split(change[0]!).length !== 2) throw Error('Select one exact prepared-stage owner mutation')
      source = source.replace(change[0]!, change[1]!)
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex'), report = process.env.PACKAGE_STAGE_LOADED
    if (report) {
      const receipt = { file, pid: process.pid, originalSHA256, loadedSHA256, ...(mutant ? { mutant } : {}) }
      source = "import { appendFileSync as __preparedLoaded } from 'node:fs'; __preparedLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    }
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-install-workbench-continuity.test.ts'], environment: 'node',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30_000 }
})
