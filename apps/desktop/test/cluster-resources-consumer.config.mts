import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
const directory = resolve(process.env.AGENTMUX_CLUSTER_RESOURCE_EVIDENCE ?? '.local/state/mesh-cluster-overview/resources-proof')
mkdirSync(directory, { recursive: true })
const mutant = process.env.AGENTMUX_CLUSTER_RESOURCE_MUTANT
const edits: Record<string, [string, string, string]> = {
  'wrong-private-runtime': ['apps/desktop/src/renderer/src/lib/node-publishing-client.ts', 'preload.owner(target, method, params,', "preload.owner({ ...target, expectedRuntimeId: 'not-the-original-runtime' }, method, params,"],
  'drop-source-binding': ['apps/desktop/src/renderer/src/components/settings/cluster-resource-observation.ts', "if (reply.node.runtimeId !== runtimeId || reply.status === 'available' && (reply.sample.node.runtimeId !== reply.node.runtimeId || reply.sample.node.ownerInstanceId !== reply.node.ownerInstanceId || reply.sample.policyRevision !== reply.policyRevision))", 'if (false)']
}
if (mutant && !edits[mutant]) throw Error('Unknown actual Cluster resource mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  cacheDir: resolve(directory, 'cache'), plugins: [{ name: 'actual-cluster-resource-consumer', enforce: 'pre', resolveId: installedDependency,
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(?:apps\/desktop\/(?:src\/(?:main\/(?:runtime-controller|node-publishing-ipc|desktop-host|desktop-rpc-exposure|ipc-sender-trust)|renderer\/src\/(?:lib\/node-publishing-client|components\/settings\/(?:ClusterMachinesPane|cluster-resource-observation|node-resource-view)))\.tsx?|test\/(?:cluster-resources-consumer\.test\.tsx|helpers\/cluster-resource-fixture\.ts))|packages\/core\/src\/(?:public-rpc-service|public-rpc-server|node-publishing|node-publishing-owner)\.ts)$/u.test(path)) return
      let source = original
      if (mutant && edits[mutant]![0] === path) {
        const [, anchor, replacement] = edits[mutant]!
        if (source.split(anchor).length !== 2) throw Error('Cluster mutant must bind one actual loaded owner: ' + mutant)
        source = source.replace(anchor, replacement)
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(resolve(directory, 'loaded.jsonl'), JSON.stringify({ path, originalSHA256: hash(original), servedSHA256: hash(source), ...(source === original ? {} : { mutant }) }) + '\n')
      return source === original ? undefined : { code: source, map: null }
    } }], test: { include: ['apps/desktop/test/cluster-resources-consumer.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts'), resolve(root, 'apps/desktop/test/helpers/cluster-resources-dom.ts')], environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 90000, hookTimeout: 30000 } })
