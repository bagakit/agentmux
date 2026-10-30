import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { isolatedGitEnvironment } from './review-guard-isolation.mjs'

const exec = promisify(execFile)

/** A real Git repository with only this test's commits and no developer configuration. */
export async function reviewGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-review-git-'))
  const env = isolatedGitEnvironment()
  async function git(args: string[]) {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Review fixture',
      '-c', 'user.email=review-fixture@example.invalid', ...args], { cwd: root, env })
    return stdout.trim()
  }
  try { await git(['init', '--quiet']) }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  return {
    root, git,
    async commit(files: Record<string, string>, message: string) {
      for (const [name, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, name)), { recursive: true })
        await writeFile(join(root, name), content)
      }
      await git(['add', '--all'])
      await git(['commit', '--quiet', '--allow-empty', '-m', message])
      return git(['rev-parse', 'HEAD'])
    },
    async cli(script: string, args: string[]) {
      try {
        const result = await exec(process.execPath, [script, ...args], { cwd: root, env })
        return { code: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const result = error as Error & { code: number | string; stdout?: string; stderr?: string }
        if (typeof result.code !== 'number') throw error
        return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
      }
    },
    close: () => rm(root, { recursive: true, force: true })
  }
}
