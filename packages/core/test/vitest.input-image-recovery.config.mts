import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import base from './vitest.input-image.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const composer = 'apps/desktop/test/composer-image-publication-consumer.case.tsx'
const consumer = 'apps/host/test/composer-image-publication-consumer.case.ts'
// Separate DOM/Node realms model the real native boundary. A fresh artifact per
// invocation prevents a successful old producer from masking a broken current one.
const artifact = process.env.AGENTMUX_TEST_IMAGE_RECOVERY_ARTIFACT ?? resolve(root, '.cache/input-image-recovery', randomUUID() + '.json')
class ComposerFirst extends BaseSequencer {
  async sort(files: TestSpecification[]) { return files.sort((a, b) => Number(b.moduleId.endsWith(composer)) - Number(a.moduleId.endsWith(composer))) }
}
const filter = " AND json_type(decision_json,'$.gap.anchor')='object' AND (json_extract(decision_json,'$.gap.code')='PUBLICATION_A2A_ORIGINAL_UNAVAILABLE' OR (json_type(decision_json,'$.gap.part')='object' AND json_type(decision_json,'$.gap.event')='object'))"
const changes: Record<string, [string, string, string]> = {
  'unreadable-head': ['packages/connectors/src/publication-store.ts', filter, ''],
  'drop-app-image': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', "send(sessionId, value, feedback.report, 'manual', undefined, { inputImages })", "send(sessionId, value, feedback.report, 'manual', undefined, { inputImages: [] })"]
}
const mutation = process.env.AGENTMUX_TEST_IMAGE_RECOVERY_MUTATION
const appOnly = !!mutation || process.env.AGENTMUX_TEST_IMAGE_RECOVERY_APP_ONLY === '1'
if (mutation && !changes[mutation]) throw Error('Unknown image recovery mutation')
export default { ...base, root, cacheDir: resolve(root, '.cache/input-image-recovery'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ ...base.plugins![0], name: 'loaded-input-image-recovery', transform(source: string, id: string) {
    if (id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') && !path.startsWith('apps/')) return
    let code = source
    const change = mutation && changes[mutation]
    if (change && path === change[0]) { if (source.split(change[1]).length !== 2) throw Error('Image recovery mutation anchor must be unique'); code = source.replace(change[1], change[2]) }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_TEST_IMAGE_RECOVERY_LOADED) appendFileSync(process.env.AGENTMUX_TEST_IMAGE_RECOVERY_LOADED, JSON.stringify({ path, sourceSHA256: sha(source), loadedSHA256: sha(code), mutation: source === code ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: appOnly ? [composer, consumer] : [composer, consumer, 'apps/host/test/input-image-publication-consumer.test.ts', 'packages/connectors/test/a2a-publication-consumer.test.ts'],
    env: { AGENTMUX_TEST_IMAGE_RECOVERY_ARTIFACT: artifact }, sequence: { sequencer: ComposerFirst },
    testNamePattern: appOnly ? '^App selected image' : '^(App selected image|default Host projects|keeps an unknown|retains a recoverable original-read gap)',
    testTimeout: 60000, fileParallelism: false, passWithNoTests: false }
}
