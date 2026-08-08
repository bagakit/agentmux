import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAgentSkills } from '../../../packages/core/src/agent-skills'
import { defineAgentProvider } from '../../../packages/core/src/agent-provider'
import { createCodexProvider } from '../../../packages/core/src/providers/codex'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('discovers actual project and user skills, resolves directory links and ignores cycles and malformed siblings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-skills-')); roots.push(root)
  const workspacePath = join(root, 'project'), home = join(root, 'home')
  const local = join(workspacePath, '.agents/skills/write'), user = join(home, '.codex/skills/read')
  await mkdir(local, { recursive: true }); await mkdir(user, { recursive: true })
  await writeFile(join(local, 'SKILL.md'), '---\nname: writer\ndescription: Write clearly\n---\nInstructions')
  await writeFile(join(user, 'SKILL.md'), '---\nname: reader\ndescription: Read evidence\n---\nInstructions')
  await symlink(local, join(home, '.codex/skills/linked'))
  await symlink(join(home, '.codex/skills'), join(home, '.codex/skills/cycle'))
  const catalog = createCodexProvider(defineAgentProvider).catalog
  const skills = await discoverAgentSkills({ catalog, workspacePath, home })
  expect(skills.map((skill) => skill.name)).toEqual(['reader', 'writer'])
  expect(skills.find((skill) => skill.name === 'writer')).toMatchObject({ path: join(local, 'SKILL.md'), source: 'project', description: 'Write clearly' })
  expect(catalog.composer?.commands.some((command) => command.text === '/status')).toBe(true)
})

const captureRunner = vi.hoisted(() => vi.fn())
vi.mock('@agentmux/core', async (original) => ({ ...await original<object>(), runProcess: captureRunner }))
it('system capture returns only a completed image and cancellation creates no reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-capture-')); roots.push(root)
  const { captureComposerScreenshot } = await import('../src/main/composer-screenshot')
  captureRunner.mockImplementationOnce(async (_command: string, args: string[]) => {
    await writeFile(args.at(-1)!, 'image')
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  expect(await captureComposerScreenshot(root)).toContain('/.agentmux/pasted/screen-')
  expect(captureRunner).toHaveBeenCalledWith('/usr/sbin/screencapture', expect.arrayContaining(['-i', '-x', '-t', 'png']), expect.any(Object))
  captureRunner.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
  expect(await captureComposerScreenshot(root)).toBeNull()
})
it('project appearance discovers project assets and distinguishes a repository from a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-icon-')); roots.push(root)
  const { projectAppearance } = await import('../src/main/project-appearance')
  expect(await projectAppearance(root)).toEqual({ kind: 'directory', icon: null })
  await mkdir(join(root, '.git')); await mkdir(join(root, 'public'))
  await writeFile(join(root, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  expect(await projectAppearance(root)).toMatchObject({ kind: 'repository', icon: expect.stringContaining('data:image/svg+xml;base64,') })
})
