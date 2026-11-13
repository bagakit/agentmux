import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Dynamic ESM import keeps this Node script's executable implementation in the owning Vite transform.
const script = '../scripts/typecheck-activity-tests.mjs'
const { createActivityTestCompilerHost } = await import(script) as {
  createActivityTestCompilerHost(root: string, options: ts.CompilerOptions): {
    host: ts.CompilerHost; resolutions: Map<string, string>; manifests: Map<string, string>
  }
}
const root = realpathSync(resolve(import.meta.dirname, '../../..'))
const originalRoots = ['apps/desktop/src/renderer/src/lib/brand-hero.ts',
  'apps/desktop/src/renderer/src/components/settings/MoteOriginStory.tsx'].map(file => join(root, file))
const records: unknown[] = []
let privateDirectory: string
beforeAll(async () => { privateDirectory = await mkdtemp(join(tmpdir(), 'activity-asset-types-')) })
afterAll(async () => {
  try {
    if (process.env.AGENTMUX_ACTIVITY_ASSET_EVIDENCE) {
      await mkdir(dirname(process.env.AGENTMUX_ACTIVITY_ASSET_EVIDENCE), { recursive: true })
      await writeFile(process.env.AGENTMUX_ACTIVITY_ASSET_EVIDENCE, JSON.stringify({
        schema: 'agentmux.activity-asset-types.v1', records
      }, null, 2) + '\n')
    }
  } finally { if (privateDirectory) await rm(privateDirectory, { recursive: true }) }
})
function options() {
  const path = join(root, 'apps/desktop/tsconfig.test.json'), config = ts.readConfigFile(path, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path), {}, path)
  expect(parsed.errors).toEqual([])
  expect(parsed.options.strict).toBe(true)
  expect(parsed.options.types).toContain('vite/client')
  return { parsed, compiler: { ...parsed.options, noEmit: true, incremental: false } }
}
function program(extra?: string) {
  const { parsed, compiler } = options(), factory = createActivityTestCompilerHost(root, compiler)
  const roots = [...originalRoots, ...parsed.fileNames.filter(file => /\.d\.[cm]?ts$/u.test(file))]
  if (extra !== undefined) {
    const file = join(root, 'apps/desktop/test/activity-asset-type-contract.ts'), get = factory.host.getSourceFile.bind(factory.host)
    factory.host.getSourceFile = (name, languageVersion, onError, create) => name === file
      ? ts.createSourceFile(name, extra, typeof languageVersion === 'number' ? languageVersion : languageVersion.languageVersion, true)
      : get(name, languageVersion, onError, create)
    roots.push(file)
  }
  const value = ts.createProgram(roots, compiler, factory.host)
  return { value, ...factory }
}
function diagnosticSummary(diagnostics: readonly ts.Diagnostic[]) {
  return diagnostics.map(value => ({ file: value.file ? relative(root, value.file.fileName) : null,
    code: value.code, message: ts.flattenDiagnosticMessageText(value.messageText, '\n') }))
}
it('the actual Brand and Mote sources consume their original AVIF and PNG imports as strings', () => {
  const checked = program(), checker = checked.value.getTypeChecker()
  const diagnostics = ts.getPreEmitDiagnostics(checked.value), imported: Array<{ file: string; specifier: string; type: string }> = []
  for (const file of originalRoots) {
    const source = checked.value.getSourceFile(file)
    expect(source).toBeDefined()
    for (const statement of source!.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/\.(avif|png)$/u.test(statement.moduleSpecifier.text)) continue
      const name = statement.importClause?.name
      expect(name).toBeDefined()
      imported.push({ file: relative(root, file), specifier: statement.moduleSpecifier.text,
        type: checker.typeToString(checker.getTypeAtLocation(name!)) })
    }
  }
  const binaries = checked.value.getSourceFiles().filter(file => /\.(avif|png)$/u.test(file.fileName)).map(file => relative(root, file.fileName))
  const inputs = [...originalRoots, ...imported.map(item => join(root, checked.resolutions.get(item.specifier)!))]
  const sourceInputs = Object.fromEntries(inputs.map(file => [relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')]))
  records.push({ case: 'actual-source-assets', sourceInputs, actualRoots: originalRoots.map(file => relative(root, file)), imported,
    binaries, diagnostics: diagnosticSummary(diagnostics), resolutions: Object.fromEntries(checked.resolutions),
    manifests: Object.fromEntries([...checked.manifests].map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])) })
  expect(imported.filter(item => item.specifier.endsWith('.avif'))).toHaveLength(2)
  expect(imported.filter(item => item.specifier.endsWith('.png'))).toHaveLength(3)
  expect(diagnostics.length, JSON.stringify(Object.fromEntries([...new Set(diagnostics.map(item => item.code))].map(code => [code, diagnostics.filter(item => item.code === code).length])))).toBe(0)
  expect(binaries).toEqual([])
  expect(imported.map(item => item.type)).toEqual(Array(5).fill('string'))
  expect(checked.resolutions.size).toBeGreaterThan(5)
  expect(checked.manifests.has('packages/client-ui/package.json')).toBe(true)
  for (const [specifier, path] of checked.resolutions) {
    expect(realpathSync(join(root, path)).startsWith(root + '/'), specifier).toBe(true)
  }
})
it('the original asset types reject incompatible numeric consumers instead of becoming any', () => {
  const checked = program(`import png from '@agentmux/client-ui/brand/illustrations/mote-origin/role-team.png'
import avif from '@agentmux/client-ui/brand/heroes/origin-banner.avif'
const wrongPng: number = png
const wrongAvif: number = avif
`)
  const diagnostics = ts.getPreEmitDiagnostics(checked.value)
  records.push({ case: 'wrong-consumer-type', diagnostics: diagnosticSummary(diagnostics) })
  expect(diagnostics.map(value => value.code)).toEqual([2322, 2322])
  expect(diagnostics.every(value => ts.flattenDiagnosticMessageText(value.messageText, ' ').includes("Type 'string' is not assignable to type 'number'"))).toBe(true)
})
it('a missing declared resource still fails before ambient wildcard handling', () => {
  const factory = createActivityTestCompilerHost(root, options().compiler)
  expect(() => factory.host.resolveModuleNames!(['@agentmux/client-ui/brand/illustrations/mote-origin/missing-resource.png'], originalRoots[1]!, undefined, undefined, options().compiler))
    .toThrow(/ENOENT|Missing declared candidate export/)
})
it('an unknown package or export still fails at its exact candidate manifest', async () => {
  const candidate = join(privateDirectory, 'missing-export'), pkg = join(candidate, 'packages/fixture')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(candidate, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n")
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@agentmux/fixture', exports: { './present': './present.ts' } }))
  await writeFile(join(pkg, 'present.ts'), 'export const original = true\n')
  const compiler = options().compiler, factory = createActivityTestCompilerHost(candidate, compiler)
  expect(() => factory.host.resolveModuleNames!(['@agentmux/fixture/absent.png'], join(candidate, 'consumer.ts'), undefined, undefined, compiler))
    .toThrow('Missing declared candidate export')
  expect(() => factory.host.resolveModuleNames!(['@agentmux/unknown/absent.png'], join(candidate, 'consumer.ts'), undefined, undefined, compiler))
    .toThrow('Expected one declared candidate package')
})
it('a declared asset outside this checkout is rejected before ambient wildcard handling', async () => {
  const candidate = join(privateDirectory, 'outside-export'), pkg = join(candidate, 'packages/fixture')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(candidate, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n")
  await writeFile(join(privateDirectory, 'outside.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@agentmux/fixture', exports: { './outside.png': './outside.png' } }))
  await symlink(join(privateDirectory, 'outside.png'), join(pkg, 'outside.png'))
  const compiler = options().compiler, factory = createActivityTestCompilerHost(candidate, compiler)
  expect(() => factory.host.resolveModuleNames!(['@agentmux/fixture/outside.png'], join(candidate, 'consumer.ts'), undefined, undefined, compiler))
    .toThrow('Candidate export escaped its checkout')
})
