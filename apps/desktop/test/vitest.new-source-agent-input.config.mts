import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import base from './vitest.workbench-recovery-bootstrap.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const owner = process.env.AGENTMUX_SOURCE_INPUT_OWNER_ROOT ?? dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
const mutation = process.env.AGENTMUX_SOURCE_INPUT_MUTATION
const edits: Record<string, [string, string, string]> = {
  'drop-goal-source-cut': ['apps/desktop/src/renderer/src/components/GoalSourceCreation.tsx', 'agentTarget: selection.agentTarget, ...sourceInput?.fields', 'agentTarget: selection.agentTarget'],
  'drop-ordinary-source-cut': ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx', 'agentTarget: sourceOwned!.agentTarget, ...sourceInput?.fields,', 'agentTarget: sourceOwned!.agentTarget,'],
  'drop-main-source-selector': ['apps/desktop/src/main/runtime-controller.ts', ', ...birth }, context)', ' }, context)'],
  'block-pinned-source-on-reader-failure': ['apps/desktop/src/renderer/src/lib/new-source-agent-input.ts', 'catch (cause) { return unconfirmed(presentError(cause)) }', 'catch (cause) { throw cause }'],
  'invent-cut-on-reader-failure': ['apps/desktop/src/renderer/src/lib/new-source-agent-input.ts', 'catch (cause) { return unconfirmed(presentError(cause)) }', "catch (cause) { return { fields: { inputRuntimeId: expectedRuntimeId, inputEpoch: 'invented-cut' } } }"],
  'accept-wrong-runtime': ['apps/desktop/src/renderer/src/lib/new-source-agent-input.ts', "if (execution.runtimeId !== expectedRuntimeId) throw new Error('The input namespace reply belongs to another Runtime. The original target and draft are retained; no creation was requested.')", ''],
  'block-optional-source-description': ['apps/desktop/src/renderer/src/hooks/useSourceLauncher.ts', 'if (value.sourceIssue) { setContractIssue({ key: sourceKey, message: value.sourceIssue.message }); return }', ''],
  'drop-main-runtime-pin': ['apps/desktop/src/main/runtime-controller.ts', '...(request.inputRuntimeId === undefined ? {} : { inputRuntimeId: request.inputRuntimeId }),', ''],
  'drop-public-resume-cut': ['apps/desktop/src/main/runtime-controller.ts', '...(inputEpoch === undefined ? {} : { inputEpoch }),', ''],
  'renew-public-control-cut': ['apps/desktop/src/renderer/src/store.ts', 'api.sessions.resume(session.control, request.text, request.requestId, undefined, request.inputEpoch)', 'api.sessions.resume(session.control, request.text, request.requestId, undefined, session.inputEpoch)']
}
if (mutation && !edits[mutation]) throw Error('Unknown Source input mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/new-source-agent-input'), plugins: [...base.plugins ?? [], {
  name: 'exact-current-source-owner', enforce: 'pre', async resolveId(specifier, importer) {
    if (!importer || !specifier.startsWith('.') && !isAbsolute(specifier)) return
    const path = isAbsolute(specifier) ? specifier : resolve(dirname(importer.split('?')[0]!), specifier)
    if (path.startsWith(resolve(root, 'packages/core') + '/')) return await this.resolve(resolve(owner, relative(root, path)), undefined, { skipSelf: true })
    if (path === resolve(root, 'apps/host/src/spatial-agent-control') || path === resolve(root, 'apps/host/src/spatial-agent-control.ts'))
      return await this.resolve(resolve(owner, relative(root, path)), undefined, { skipSelf: true })
  }, transform(source, id) {
    const absolute = id.split('?')[0]!, path = relative(root, absolute), edit = mutation && edits[mutation]
    let code = source
    if (edit && path === edit[0]) { if (!code.includes(edit[1])) throw Error('Missing exact Source consumer mutation anchor'); code = code.replaceAll(edit[1], edit[2]) }
    const output = process.env.AGENTMUX_SOURCE_INPUT_SOURCE_PROOF
    if (output && (absolute.startsWith(root + '/apps/') || absolute.startsWith(owner + '/packages/core/') || absolute === resolve(owner, 'apps/host/src/spatial-agent-control.ts'))) appendFileSync(output,
      JSON.stringify({ path: absolute, owner: absolute.startsWith(root + '/') ? 'implementation' : 'current-original-owner', sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        compiledSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation }) + '\n', { mode: 0o600 })
    return source === code ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: process.env.AGENTMUX_SOURCE_INPUT_SELECTION === 'helper' ? ['apps/desktop/test/new-source-agent-input.test.tsx']
  : process.env.AGENTMUX_SOURCE_INPUT_SELECTION === 'goal' ? ['apps/desktop/test/goal-source-creation.test.tsx']
  : process.env.AGENTMUX_SOURCE_INPUT_SELECTION === 'ordinary' ? ['apps/desktop/test/ordinary-source-admission.test.tsx']
  : process.env.AGENTMUX_SOURCE_INPUT_SELECTION === 'input' ? ['apps/desktop/test/input-epoch-consumer.test.tsx']
  : ['apps/desktop/test/new-source-agent-input.test.tsx', 'apps/desktop/test/goal-source-creation.test.tsx',
  'apps/desktop/test/ordinary-source-admission.test.tsx', 'apps/desktop/test/input-epoch-consumer.test.tsx'],
  testNamePattern: /first Source birth|unavailable namespace reader|wrong Runtime reply|original Main IPC|optional Source description|the Goal picker uses original Source|denied namespace observation|ordinary Source Start crosses|Main maps the frozen create|an original Reach C with an unknown ACK|Main preserves the original public resume|actual public resume control/,
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 25_000 } })
