import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { writeEmbeddedCoreCli } from '../scripts/embedded-core-cli.mjs'

const exec = promisify(execFile)
it('both packaged amux locations use the embedded runtime and same dispatcher without PATH Node', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-embedded-cli-"))
  try {
    const contents = join(root, "App with ' quote.app", 'Contents')
    const executable = join(contents, 'MacOS', 'AgentMux')
    const core = join(contents, 'Resources', 'node_modules', '@agentmux', 'core')
    const dispatcher = join(core, 'dist', 'agentmux.js')
    await mkdir(dirname(executable), { recursive: true }); await symlink(process.execPath, executable)
    await mkdir(dirname(dispatcher), { recursive: true })
    await writeFile(dispatcher, 'console.log(JSON.stringify({embedded:process.env.ELECTRON_RUN_AS_NODE,args:process.argv.slice(2)}))\n')
    for (const bin of [join(core, 'bin'), join(contents, 'Resources', 'out', 'bin')]) {
      await mkdir(bin, { recursive: true })
      const launcher = join(bin, 'amux')
      const legacy = join(bin, 'agentmux')
      await writeEmbeddedCoreCli(launcher, executable, dispatcher)
      await symlink('amux', legacy)
      const reply = await exec(launcher, ['argument with spaces', "'quoted"], { env: { PATH: '/usr/bin:/bin' } })
      expect(JSON.parse(reply.stdout)).toEqual({ embedded: '1', args: ['argument with spaces', "'quoted"] })
      const legacyReply = await exec(legacy, ['argument with spaces', "'quoted"], { env: { PATH: '/usr/bin:/bin' } })
      expect(JSON.parse(legacyReply.stdout)).toEqual({ embedded: '1', args: ['argument with spaces', "'quoted"] })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
