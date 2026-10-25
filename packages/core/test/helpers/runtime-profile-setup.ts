import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Supply the existing Renderer CLI test's private carrier, never the running App. */
export default async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-profile-'))
  const frozen = join(directory, 'sources.json'), preImport = join(directory, 'pre-import.mjs')
  await writeFile(frozen, '{}')
  await writeFile(preImport, "for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]\n")
  process.env.PROFILE_UNIT_OUTPUT = directory
  process.env.PROFILE_NAMESPACE = directory
  process.env.AGENTMUX_PERFORMANCE_SOURCES = frozen
  process.env.PROFILE_PRE_IMPORT_MODULE = preImport
  return async () => { await rm(directory, { recursive: true, force: true }) }
}
