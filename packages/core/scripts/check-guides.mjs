import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const core = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--dist') || args.length > 1) throw new Error('Usage: check-guides.mjs [--dist]')

// Consume real owners, including dynamic registry facts, without maintaining a
// second command or guide manifest. These functions render local documents only.
async function check(directory) {
  const load = name => import(pathToFileURL(join(directory, name + '.js')).href)
  const [modules, help, commands, generated, pmo, outbound, goal, patrol] = await Promise.all([
    'agentmux-cli-module-skills', 'agentmux-cli-help', 'agentmux-cli-commands', 'generated/agentmux-guides-index',
    'agentmux-pmo-playbook', 'agent-outbound-message', 'goal-role-guidance', 'goal-patrol'
  ].map(load))
  const roots = [...new Set(commands.AGENTMUX_CLI_COMMANDS.map(command => command.method.split('.')[0]))].sort()
  if (!roots.length || JSON.stringify(roots) !== JSON.stringify(Object.keys(generated.MODULE_GUIDES).sort()))
    throw new Error('Module guides differ from the executable command registry')
  const texts = [modules.agentMuxBaseSkill(), ...roots.map(modules.agentMuxModuleSkill),
    ...commands.AGENTMUX_CLI_COMMANDS.map(command => help.agentMuxCommandHelp(command.method)),
    pmo.agentMuxPmoPlaybook().document, outbound.composeAgentLaunchPrompt('guide check', true).systemContext,
    outbound.composeAgentResumePrompt('guide check').systemContext,
    goal.goalRoleGuidance({ role: 'executor' }), goal.goalRoleGuidance({ role: 'manager' }), patrol.GLOBAL_GOAL_PATROL_GUIDANCE]
  if (texts.some(text => typeof text !== 'string' || !text.trim() || text.includes('<!-- amux:generated ')))
    throw new Error('A built-in guide consumer is empty or has an unresolved fact')
}

if (args.includes('--dist')) await check(join(core, 'dist'))
else {
  // A source check never trusts a previous dist. Translate the same module graph
  // into a private temporary directory and remove it even when a consumer fails.
  const temporary = await mkdtemp(join(tmpdir(), 'amux-guide-check-'))
  try {
    const source = join(core, 'src'), output = join(temporary, 'dist')
    const files = (await readdir(source, { recursive: true })).sort()
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
    await symlink(join(core, 'node_modules'), join(temporary, 'node_modules'), 'dir')
    await symlink(join(core, 'vendor'), join(temporary, 'vendor'), 'dir')
    await build({ entryPoints: files.filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts')).map(file => join(source, file)),
      outbase: source, outdir: output, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' })
    for (const file of files.filter(file => /\.(json|mjs)$/u.test(file))) {
      const destination = join(output, relative(source, join(source, file)))
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(source, file), destination)
    }
    await check(output)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
console.log('Checked real module, help, PMO, runtime and Goal guide consumers.')
