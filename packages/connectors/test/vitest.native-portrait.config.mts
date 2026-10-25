import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import host from '../../../apps/host/test/connection-owner-consumer.config.mts'

const root = host.root!, mutant = process.env.NATIVE_PORTRAIT_MUTANT
if (mutant && !['create-blocks-body', 'portrait-overtakes-body', 'legacy-image', 'stale-readback', 'question-create-authority', 'late-source-disconnected', 'avatar-scope-crossed'].includes(mutant)) throw Error('Unknown native portrait mutation')
export default defineConfig({ ...host, cacheDir: resolve(root, '.cache/native-portrait-publication'), plugins: [{
  name: 'loaded-native-portrait', enforce: 'pre', resolveId(source) {
    if (source === '@agentmux/client-ui/theme') return resolve(root, 'packages/client-ui/src/theme/index.ts')
    if (source.startsWith('@agentmux/client-ui/note/')) return resolve(root, 'packages/client-ui/src/note', source.slice('@agentmux/client-ui/note/'.length) + '.ts')
    if (source.startsWith('@agentmux/client-ui/components/')) return resolve(root, 'packages/client-ui/src/components', source.slice('@agentmux/client-ui/components/'.length) + '.tsx')
    if (source.startsWith('@agentmux/client-ui/')) return resolve(root, 'packages/client-ui/src/lib', source.slice('@agentmux/client-ui/'.length) + '.ts')
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/(?:src|test)\/.+\.[cm]?[jt]s$/u.test(path)) return
    let output = input
    const mutations = {
      'late-source-disconnected': ['packages/connectors/src/publication-host.ts', 'const retained = this.store.settleAvatarResource(original.operationId, resource)', 'const retained = undefined'],
      'avatar-scope-crossed': ['packages/connectors/src/publication-store.ts', "AND json_extract(operation_json,'$.target.connectionId')=? AND json_extract(operation_json,'$.target.application.domain')=?\n            AND json_extract(operation_json,'$.target.application.appId')=? AND json_extract(operation_json,'$.speaker.avatar.image.sha256')=?", "AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND json_extract(operation_json,'$.speaker.avatar.image.sha256')=?"],
      'create-blocks-body': ['packages/connectors/src/publication-host.ts', "if (!this.queryAuthorized(original, binding)) { after = original.operationId; continue }", "if (original.cardPreparation?.receipt.state === 'unknown') return { state: 'unknown', reason: 'effect-unconfirmed' }; if (!this.queryAuthorized(original, binding)) { after = original.operationId; continue }"],
      'portrait-overtakes-body': ['packages/connectors/src/publication-store.ts', "if (latest?.operationId !== original.operationId) {", "if (false && latest?.operationId !== original.operationId) {"],
      'stale-readback': ['packages/connectors/src/publication-store.ts', "if (evidence === 'readback' && !this.portraitInspectable(original)) return original", "if (false && evidence === 'readback' && !this.portraitInspectable(original)) return original"],
      'question-create-authority': ['packages/connectors/src/publication-host.ts', "const cardAuthorized = () => authorized() && (original!.payload.kind !== 'question' || this.options.permissions?.authorized(original!) === true)", "const cardAuthorized = () => authorized()"],
      'legacy-image': ['packages/connectors/src/adapters/feishu/publication.ts', "card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Shared image' } },", "card = { schema: '1.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Shared image' } },"]
    } as const
    const selected = mutant && mutations[mutant as keyof typeof mutations]
    if (selected && path === selected[0]) {
      const matches = input.split(selected[1]).length - 1
      if (matches !== (mutant === 'create-blocks-body' ? 2 : 1)) throw Error('Native portrait mutation requires its exact owner')
      output = input.replaceAll(selected[1], selected[2])
    }
    if (process.env.NATIVE_PORTRAIT_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, original: sha(input), loaded: sha(output), ...(input === output ? {} : { mutant }) }
      output = "import { appendFileSync as __portraitLoaded } from 'node:fs'; __portraitLoaded(" + JSON.stringify(process.env.NATIVE_PORTRAIT_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output
    }
    return output === input ? undefined : { code: output, map: null }
  }
}, ...host.plugins!], test: { ...host.test,
  include: ['apps/host/test/native-portrait-publication-consumer.test.ts'], testTimeout: 60000
} })
