import { describe, expect, it } from 'vitest'
import { fixturePath } from './helpers/fixture-values.js'
import { resolveToolkitWorkspacePath, DEFAULT_TOOLKIT_WORKSPACE_PATH } from '../src/toolkit-working-directory.js'
import { parseToolkitCommand } from '../src/toolkit-cli.js'

const home = fixturePath('toolkit-home')
describe('Toolkit working directory expressions', () => {
  it.each(['~', '$HOME', '${HOME}'])('expands only the exact Host home prefix %s', prefix => {
    expect(resolveToolkitWorkspacePath(prefix, home)).toBe(home)
    expect(resolveToolkitWorkspacePath(prefix + '/two words/目录', home)).toBe(home + '/two words/目录')
  })
  it('keeps absolute paths and suffixes literal, including symlink parent traversal and shell characters', () => {
    const suffix = '/link/../two words/$OTHER/$(command)/*'
    expect(resolveToolkitWorkspacePath('~' + suffix, home)).toBe(home + suffix)
    expect(resolveToolkitWorkspacePath(home + suffix, '')).toBe(home + suffix)
    expect(resolveToolkitWorkspacePath(DEFAULT_TOOLKIT_WORKSPACE_PATH, home)).toBe(home + '/.agentmux')
    expect(resolveToolkitWorkspacePath('~/tools', '/')).toBe('/tools')
  })
  it.each(['', 'relative', './tools', '../tools', '~other/tools', '$HOMEother/tools', '$OTHER/tools', '$(command)', '"~/tools"', '/bad\0path'])('reports the working directory for unsupported input %j', value => {
    expect(() => resolveToolkitWorkspacePath(value, home)).toThrow(/Working directory/u)
    try { resolveToolkitWorkspacePath(value, home) } catch (error) { expect(error).toMatchObject({ code: 'INVALID_SETTING_VALUE' }) }
  })
  it('keeps unknown Host home distinct from a malformed directory', () => {
    expect(() => resolveToolkitWorkspacePath('~/tools', '')).toThrow(expect.objectContaining({ code: 'HOST_HOME_UNAVAILABLE', detail: 'toolkit.workspacePath' }))
    expect(resolveToolkitWorkspacePath(home, '')).toBe(home)
  })
  it('preserves install cwd shorthand for the execution Host rather than expanding the CLI user home', async () => {
    const parsed = await parseToolkitCommand(['install', 'directory-package', '--path', fixturePath('package'), '--cwd', '${HOME}/tool files'])
    expect(parsed.params).toMatchObject({ value: { workspacePath: '${HOME}/tool files' } })
    await expect(parseToolkitCommand(['install', 'directory-package', '--path', 'relative'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  })
})
