// Stages this release's Core with the same program the App's Core upgrade runs on
// a remote Host, so a first install and later in-app upgrades share one layout:
// <state>/core-releases/<digest>/ with deployment.json and launcher/amux.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1]
  if (!['--core', '--state', '--node'].includes(name) || !value || !isAbsolute(value)) {
    process.stderr.write('stage.mjs --core DIR --state DIR --node FILE (absolute paths)\n'); process.exit(2)
  }
  options[name.slice(2)] = value
}
if (!options.core || !options.state || !options.node) { process.stderr.write('stage.mjs requires --core, --state and --node\n'); process.exit(2) }

const deployment = JSON.parse(readFileSync(join(options.core, 'deployment.json'), 'utf8'))
const params = {
  stateDirectory: options.state, node: options.node, digest: deployment.digest, operationId: `install-${randomUUID()}`,
  archive: readFileSync(join(options.core, 'core.tar.gz')).toString('base64'), archiveDigest: deployment.archiveDigest, files: deployment.files
}
const program = join(dirname(fileURLToPath(import.meta.url)), 'stage-core.cjs')
const result = spawnSync(options.node, [program], { input: JSON.stringify(params), encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (result.status !== 0) {
  process.stderr.write(`AgentMux Core staging failed.\n${result.stderr || result.error?.message || ''}\n`); process.exit(1)
}
const staged = JSON.parse(result.stdout.trim())
const release = join(options.state, 'core-releases', deployment.digest)
if (staged.digest !== deployment.digest || staged.releaseDirectory !== release || staged.remoteCommand !== join(release, 'launcher', 'amux')) {
  process.stderr.write('AgentMux Core staging returned a receipt for another release.\n'); process.exit(1)
}
// A first install names its release for the entry and restart. Once a release is named,
// only a confirmed App Core upgrade moves the pointer; a rerun only stages.
if (!existsSync(join(options.state, 'core-releases', 'current'))) {
  const selected = spawnSync(options.node, [join(dirname(fileURLToPath(import.meta.url)), 'select-core.cjs')],
    { input: JSON.stringify({ stateDirectory: options.state, digest: deployment.digest, operationId: params.operationId }), encoding: 'utf8' })
  if (selected.status !== 0 || JSON.parse(selected.stdout.trim()).current !== deployment.digest) {
    process.stderr.write(`AgentMux Core could not name the installed release.\n${selected.stderr || ''}\n`); process.exit(1)
  }
}
process.stdout.write(release + '\n')
