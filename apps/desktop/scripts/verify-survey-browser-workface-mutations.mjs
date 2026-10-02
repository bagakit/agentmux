import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

// Task-specific private Renderer sources. Shared packages and installed dependencies are read-only.
const root = resolve(import.meta.dirname, '../../..')
const renderer = 'apps/desktop/src/renderer/src/'
const survey = `${renderer}components/GlobalSurveySurface.tsx`, workbench = `${renderer}components/WorkspaceWorkbench.tsx`
const app = `${renderer}App.tsx`, projection = `${renderer}lib/workbench-projection.ts`, store = `${renderer}store.ts`
const tests = ['apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/test/survey-zone-controls.test.tsx', 'apps/desktop/test/browser-tools-density.test.tsx']
const args = process.argv.slice(2)
let sidebarSlice = false, only = null
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === '--slice') {
    assert.equal(args[++index], 'sidebar', '--slice requires sidebar.')
    sidebarSlice = true
  } else if (argument === '--only') {
    const names = args[++index]
    assert.ok(names && !names.startsWith('--') && names.split(',').every(Boolean), '--only requires mutation names.')
    only = new Set(names.split(','))
  } else assert.ok(['--check-callers', '--region-only', '--placement-only', '--catalog-only'].includes(argument), `Unknown argument: ${argument}`)
}
if (args.includes('--check-callers')) {
  assert.deepEqual(args, ['--check-callers'], '--check-callers cannot run mutations or combine with mutation selectors.')
  await checkCallers()
}

/** Read the actual product calls without a mutation copy, child process, or Runtime control. */
async function checkCallers() {
  const receipt = { schema: 'agentmux.survey-production-callers.v1', mode: '--check-callers', passed: false,
    childProcesses: 0, temporaryCopies: 0, runtimeControl: [], calls: [], jsx: [] }
  try {
    const ts = createRequire(join(root, 'apps/desktop/package.json'))('typescript')
    const cli = 'packages/core/src/agentmux.ts', registry = 'packages/core/src/agentmux-cli-commands.ts', publicClient = 'packages/core/src/public-rpc-client.ts', creation = `${renderer}lib/survey-browser-creation.ts`, spatial = `${renderer}lib/space-agent-control.ts`
    const stable = `${renderer}components/StableWorkbenchView.tsx`
    const requirements = [
      { label: 'survey-zone-create', caller: survey, name: 'createWorkbenchZone', owner: store },
      { label: 'survey-browser-preparation', caller: survey, name: 'openLauncher', owner: store },
      { label: 'survey-browser-create', caller: survey, name: 'createSurveyBrowser', owner: store },
      { label: 'original-survey-browser-owner', caller: store, name: 'createSurveyBrowser', owner: creation },
      { label: 'original-browser-create-owner', caller: creation, name: 'createBrowser', owner: store },
      { label: 'survey-topic-relation', caller: survey, name: 'setZoneSpaceRelation', owner: store },
      { label: 'survey-exact-open', caller: survey, name: 'executeControl', owner: store, operations: ['focus'] },
      { label: 'original-zone-owner', caller: store, name: 'createSpatialZone', owner: spatial },
      { label: 'original-spatial-control-owner', caller: store, name: 'executeSpatialControl', owner: spatial },
      { label: 'app-workbench-projection', caller: app, name: 'projectWorkbenchProjection', owner: projection },
      { label: 'original-workbench-projection', caller: workbench, name: 'projectWorkbenchProjection', owner: projection },
      { label: 'cli-topic-binding-parser', caller: cli, name: 'parseAgentMuxCliInvocation', owner: registry, methods: ['space.bind', 'space.unbind'] },
      { label: 'cli-topic-binding-transport', caller: cli, name: 'call', owner: publicClient, methods: ['space.bind', 'space.unbind'] },
      { label: 'cli-zone-open-parser', caller: cli, name: 'parseAgentMuxCliInvocation', owner: registry, methods: ['agent.open'] },
      { label: 'cli-zone-open-transport', caller: cli, name: 'call', owner: publicClient, methods: ['agent.open'] },
      { label: 'cli-exact-focus-parser', caller: cli, name: 'parseAgentMuxCliInvocation', owner: registry, methods: ['space.focus'] },
      { label: 'cli-exact-focus-transport', caller: cli, name: 'call', owner: publicClient, methods: ['space.focus'] }
    ]
    const components = [
      { label: 'app-survey', caller: app, name: 'GlobalSurveySurface', owner: survey },
      { label: 'survey-original-workbench', caller: survey, name: 'WorkspaceWorkbench', owner: workbench },
      { label: 'workbench-original-content', caller: workbench, name: 'StableWorkbenchView', owner: stable },
      { label: 'survey-item-menu', caller: survey, name: 'SurveyItemOptions', owner: `${renderer}components/SurveyItemOptions.tsx` },
      { label: 'survey-topic-menu', caller: `${renderer}components/SurveyItemOptions.tsx`, name: 'SurveyTopicRelations', owner: `${renderer}components/SurveyTopicRelations.tsx` }
    ]
    const callerFiles = [...new Set([...requirements, ...components].map(item => item.caller))]
    const config = ts.readConfigFile(join(root, 'apps/desktop/tsconfig.json'), ts.sys.readFile)
    assert.equal(config.error, undefined, 'The actual desktop TypeScript configuration must be readable.')
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'apps/desktop'))
    assert.equal(parsed.errors.length, 0, 'The actual desktop TypeScript configuration must parse.')
    const program = ts.createProgram(callerFiles.map(file => join(root, file)), { ...parsed.options, baseUrl: root,
      paths: { '@agentmux/core': ['packages/core/src/index.ts'], '@agentmux/core/*': ['packages/core/src/*'], '@agentmux/layout': ['packages/layout/src/index.ts'] } })
    const checker = program.getTypeChecker()
    const path = file => relative(root, file).replaceAll('\\', '/')
    const productionFile = file => !file.endsWith('.d.ts') && !/(^|\/)(test|tests|node_modules)(\/|$)|\.test\.[cm]?[jt]sx?$/.test(file)
    const sourceFiles = program.getSourceFiles().filter(source => path(source.fileName).startsWith('apps/desktop/src/') || path(source.fileName).startsWith('packages/core/src/') || path(source.fileName).startsWith('packages/layout/src/'))
    assert.ok(sourceFiles.length > 0, 'The actual typed production-source scan must not be empty.')
    const sha = bytes => createHash('sha256').update(bytes).digest('hex')
    receipt.inputsBefore = Object.fromEntries(sourceFiles.map(source => [path(source.fileName), sha(source.text)]))
    for (const file of ['apps/desktop/tsconfig.json', 'tsconfig.base.json', 'apps/desktop/scripts/verify-survey-browser-workface-mutations.mjs']) receipt.inputsBefore[file] = sha(await readFile(join(root, file)))
    const symbolAt = node => {
      const symbol = checker.getSymbolAtLocation(node)
      return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    }
    const location = node => {
      const source = node.getSourceFile(), position = source.getLineAndCharacterOfPosition(node.getStart(source))
      return { file: path(source.fileName), line: position.line + 1, column: position.character + 1 }
    }
    const operations = argument => {
      if (!argument || !ts.isObjectLiteralExpression(argument)) return []
      const operation = argument.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === 'operation')
      return operation && ts.isStringLiteral(operation.initializer) ? [operation.initializer.text] : []
    }
    const unwrap = node => node && (ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) ? unwrap(node.expression) : node
    const nodes = (source, predicate) => {
      const found = []
      const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit) }
      visit(source); return found
    }
    const signatureFrom = (call, owner) => path(checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName ?? '') === owner
    const cliSource = program.getSourceFile(join(root, cli)), registrySource = program.getSourceFile(join(root, registry))
    assert.ok(cliSource && registrySource, 'The sole CLI and command registry must be actual loaded production Source.')
    const parserCalls = nodes(cliSource, node => ts.isCallExpression(node) && symbolAt(node.expression)?.getName() === 'parseAgentMuxCliInvocation' && signatureFrom(node, registry))
    assert.equal(parserCalls.length, 1, 'Exactly one typed invocation parser is called by the actual CLI.')
    const parsedDeclaration = parserCalls[0].parent.parent
    assert.ok(ts.isVariableDeclaration(parsedDeclaration) && unwrap(parsedDeclaration.initializer) === parserCalls[0] && ts.isIdentifier(parsedDeclaration.name), 'The CLI retains one parsed invocation symbol.')
    const invocation = symbolAt(parsedDeclaration.name)
    const invocationProperty = (node, property) => ts.isPropertyAccessExpression(node) && node.name.text === property && ts.isIdentifier(node.expression) && symbolAt(node.expression) === invocation
    const transports = nodes(cliSource, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'call' && signatureFrom(node, publicClient))
    assert.equal(transports.length, 1, 'Exactly one typed public client call carries ordinary CLI invocations.')
    const transported = transports[0], method = unwrap(transported.arguments[0]), params = unwrap(transported.arguments[1])
    assert.ok(method && ts.isIdentifier(method) && params && invocationProperty(params, 'params'), 'Transport carries the original invocation params, not a copied request.')
    const methodDeclarations = symbolAt(method)?.declarations ?? []
    assert.equal(methodDeclarations.length, 1, 'The transported method has one original declaration.')
    const binding = methodDeclarations[0]
    assert.ok(ts.isBindingElement(binding) && binding.name.getText() === 'method' && ts.isVariableDeclaration(binding.parent.parent) && invocationProperty(binding.parent.parent.initializer, 'command'), 'Method comes from that same invocation.command.')
    const clientDeclarations = symbolAt(transported.expression.expression)?.declarations ?? []
    assert.equal(clientDeclarations.length, 1, 'The ordinary transport uses one connected client.')
    const connection = unwrap(clientDeclarations[0].initializer)
    assert.ok(connection && ts.isCallExpression(connection) && symbolAt(connection.expression)?.getName() === 'connectAgentMuxRpc' && signatureFrom(connection, publicClient), 'The original sole public client is the actual connected receiver.')
    const registrations = nodes(registrySource, node => ts.isVariableDeclaration(node) && node.name.getText() === 'AGENTMUX_CLI_COMMANDS')
    assert.equal(registrations.length, 1, 'One actual executable registry owns these methods.')
    const literalValues = node => {
      if (ts.isStringLiteral(node)) return [node.text]
      if (!ts.isTemplateExpression(node)) return []
      let values = [node.head.text]
      for (const span of node.templateSpans) {
        const type = checker.getTypeAtLocation(span.expression), parts = type.isUnion() ? type.types : [type]
        if (!parts.length || parts.some(part => !part.isStringLiteral())) return []
        values = values.flatMap(prefix => parts.map(part => prefix + part.value + span.literal.text))
      }
      return values
    }
    const registered = nodes(registrations[0].initializer, node => ts.isCallExpression(node) && symbolAt(node.expression)?.getName() === 'command' && signatureFrom(node, registry))
      .flatMap(node => literalValues(node.arguments[0]).map(method => ({ method, ...location(node), owner: location(checker.getResolvedSignature(node).declaration) })))
    assert.ok(registered.length > 0, 'Executable command factory calls cannot be empty or replaced with imports/definitions.')
    const parser = symbolAt(parserCalls[0].expression).declarations.find(ts.isFunctionDeclaration)
    const parseReturns = nodes(parser.body, node => ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression))
    assert.equal(parseReturns.length, 1, 'Invocation parser returns the original matched command and its parsed params together.')
    const properties = parseReturns[0].expression.properties
    const commandValue = properties.find(node => ts.isPropertyAssignment(node) && node.name.getText() === 'command')?.initializer
    const paramsValue = unwrap(properties.find(node => ts.isPropertyAssignment(node) && node.name.getText() === 'params')?.initializer)
    assert.ok(commandValue && ts.isPropertyAccessExpression(commandValue) && commandValue.name.text === 'command' && paramsValue && ts.isCallExpression(paramsValue) && signatureFrom(paramsValue, registry) && ts.isPropertyAccessExpression(paramsValue.expression) && paramsValue.expression.name.text === 'parse' && paramsValue.expression.expression.getText() === commandValue.getText(), 'Params are parsed by that exact matched registry command.')
    const matches = symbolAt(unwrap(commandValue.expression))?.declarations ?? []
    assert.equal(matches.length, 1, 'The matched registry entry is unambiguous.')
    const matching = unwrap(matches[0].initializer)
    assert.ok(matching && ts.isCallExpression(matching) && symbolAt(matching.expression)?.getName() === 'agentMuxCliMatch' && signatureFrom(matching, registry), 'Invocation matching comes from the sole registry owner.')
    const matcher = symbolAt(matching.expression).declarations.find(ts.isFunctionDeclaration)
    assert.equal(nodes(matcher.body, node => ts.isForOfStatement(node) && symbolAt(node.expression) === symbolAt(registrations[0].name)).length, 1, 'The matcher enumerates the actual executable registry.')
    receipt.cliPipeline = { parser: location(parserCalls[0]), connection: location(connection), call: location(transported), parsedParams: location(paramsValue), matcher: location(matching), registered }
    const calls = [], jsx = []
    for (const file of callerFiles) {
      assert.ok(productionFile(file), `A caller must be production source: ${file}`)
      const source = program.getSourceFile(join(root, file))
      assert.ok(source, `The actual caller source must be loaded: ${file}`)
      const visit = node => {
        const call = ts.isCallExpression(node), element = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
        if (call || element) {
          const expression = call ? ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression : node.tagName
          const symbol = symbolAt(expression), name = symbol?.getName()
          const expected = call ? requirements : components
          if (expected.some(item => item.caller === file && item.name === name)) {
            const signatureOwner = call ? checker.getResolvedSignature(node)?.declaration?.getSourceFile() : null
            for (const declaration of symbol.declarations ?? []) {
              const owner = path(declaration.getSourceFile().fileName)
              if (owner === file || !productionFile(owner) || !expected.some(item => item.caller === file && item.name === name && item.owner === owner)) continue
              if (call && (!signatureOwner || path(signatureOwner.fileName) !== owner)) continue
              const fact = { ...location(node), kind: call ? 'CallExpression' : 'JSX', name, owner: location(declaration), ...(call ? { operations: operations(node.arguments[0]) } : {}) }
              if (element && name === 'WorkspaceWorkbench') {
                assert.ok(node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'projection' && attribute.initializer), 'Survey must pass the original typed projection to WorkspaceWorkbench.')
                assert.ok(node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'viewOwnership' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'projection'), 'Survey loads the original projection without another content owner.')
              }
              if (call) calls.push(fact); else jsx.push(fact)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    assert.ok(calls.length > 0, 'The actual production CallExpression collection must not be empty.')
    assert.ok(jsx.length > 0, 'The actual production JSX-consumer collection must not be empty.')
    for (const requirement of requirements) {
      let found = calls.filter(call => call.file === requirement.caller && call.name === requirement.name && call.owner.file === requirement.owner &&
        (!requirement.operations || JSON.stringify(call.operations) === JSON.stringify([...requirement.operations].sort())))
      if (requirement.methods) {
        for (const method of requirement.methods) {
          const declarations = registered.filter(entry => entry.method === method)
          assert.equal(declarations.length, 1, `One actual executable method registration: ${method}`)
        }
        found = found.map(call => ({ ...call, methods: requirement.methods.map(method => registered.find(entry => entry.method === method)) }))
      }
      assert.ok(found.length > 0, `No actual typed production caller: ${requirement.label}`)
      receipt.calls.push({ label: requirement.label, found })
    }
    for (const component of components) {
      const found = jsx.filter(element => element.file === component.caller && element.name === component.name && element.owner.file === component.owner)
      assert.ok(found.length > 0, `No actual typed production JSX consumer: ${component.label}`)
      receipt.jsx.push({ label: component.label, found })
    }
    receipt.inputsAfter = Object.fromEntries(await Promise.all(Object.keys(receipt.inputsBefore).map(async file => [file, sha(await readFile(join(root, file)))])))
    assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore, 'The read-only caller scan must leave its actual sources unchanged.')
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, code: error.code, message: error.message } }
  console.log(JSON.stringify(receipt, null, 2))
  // Let stdout drain naturally, including a failed receipt consumed through a pipe.
  if (!receipt.passed) process.exitCode = 1
}

if (!args.includes('--check-callers')) {
const copy = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-survey-zone-mutation-")))
const evidence = join(root, '.tmp', ("survey-zone-caller-mutations-" + (globalThis.crypto.randomUUID()) + ""))
const mutations = [
  { slice: 'sidebar', label: 'sidebar-groups-by-display-instead-of-resource', file: survey, before: 'const resource = resourceWorkspaces.get(zone.workspaceId)', after: 'const resource = resourceWorkspaces.get(activeWorkspaceId!)' },
  { slice: 'sidebar', label: 'sidebar-project-opens-first-worktree', file: survey, before: 'project?.preferredWorkspaceId ?? null', after: 'project?.workspaces[0]?.id ?? null' },
  { slice: 'sidebar', label: 'sidebar-pointer-commit-disconnected', file: survey, before: 'setWidth: setSidebarWidth, deltaSign: 1', after: 'setWidth: () => {}, deltaSign: 1' },
  { slice: 'sidebar', label: 'sidebar-keyboard-disconnected', file: survey, before: 'if (next === null) return', after: 'if (true) return' },
  { slice: 'sidebar', label: 'sidebar-ignores-available-space', file: `${renderer}lib/survey-sidebar-width.ts`, before: 'availableWidth > 0 ?', after: 'false ?' },
  { slice: 'sidebar', label: 'sidebar-preference-not-restored', file: store, before: 'surveySidebarWidth: clampSurveySidebarWidth(persisted.surveySidebarWidth ?? SURVEY_SIDEBAR_DEFAULT_WIDTH)', after: 'surveySidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH' },
  { slice: 'sidebar', label: 'sidebar-preference-not-saved', file: store, before: 'surveySidebarWidth: state.surveySidebarWidth,', after: 'surveySidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH,' },
  { slice: 'sidebar', label: 'sidebar-save-failure-silenced', file: store, before: '// Commit only the finished presentation gesture through the existing save owner.\n    void saveWorkbenchSelection(false)', after: '// Mutated: no original save receipt is requested.\n    void 0' },
  { slice: 'sidebar', label: 'sidebar-operation-details-hidden', file: `${renderer}components/SurveyZoneItem.tsx`, before: '{activityDetails}</div>', after: '</div>' },
  { label: 'session-status-rebuilds-spatial-directory', file: app, before: 'const byId = sessionPresentationById(state.sessions)', after: 'return state.sessions\n    const byId = sessionPresentationById(state.sessions)' },
  { label: 'same-address-replaced-slot-loses-content', file: `${renderer}components/StableWorkbenchView.tsx`, before: '}) // The original layout can replace a slot without changing its exact address.', after: '}, [homeId, targetId, host, showHomeNotice])' },
  { label: 'direct-region-paints-parent-tab', file: projection, before: "if (scope.entity.kind === 'region') return { layout: null,", after: 'if (false) return { layout: null,' },
  { label: 'conflicting-unknown-selection-picks-winner', file: projection, before: 'if (references.length !== 1)', after: 'if (false)' },
  { label: 'retry-mints-another-zone', file: survey, before: 'let preparation = newItem ? null : failedCreation.current', after: 'let preparation = null' },
  { label: 'late-attached-browser-not-recognized', file: survey, before: 'if (!confirmedBrowser)', after: 'if (true)' },
  { label: 'new-item-query-lost', file: survey, before: 'if (query.trim()) void openBrowser(query)', after: "if (query.trim()) void openBrowser('about:blank')" },
  { label: 'pending-create-steals-selection', file: survey, before: "intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection", after: "current.mainSurface === 'survey'" },
  { label: 'tab-selection-changes-space-layout', file: workbench, before: 'onClick={() => projection ? selectWorkbenchProjectionTab(projection, group.id, tab) : activateTab(workspaceId, group.id, tab.id)}', after: 'onClick={() => activateTab(workspaceId, group.id, tab.id)}' },
  { label: 'region-input-selection-disconnected', file: workbench, before: 'if (browserPresentation.onSelectRegion) browserPresentation.onSelectRegion(node.regionId)', after: 'if (browserPresentation.onSelectRegion) void node.regionId' },
  { label: 'foreign-tab-created-at-resource-display', file: workbench, before: 'displayWorkspaceId: projection.displayWorkspaceId, tabGroupId: groupId, zoneId: zone.zoneId', after: 'displayWorkspaceId: zone.workspaceId, tabGroupId: groupId, zoneId: zone.zoneId' },
  { label: 'new-tab-rejected-by-previous-catalog', file: app, before: 'if (!matches(surveyCatalog) && !matches(spatialCatalog(state, surveyTopics ?? []))) return', after: 'if (!matches(surveyCatalog)) return' },
  { label: 'content-tree-remounts-on-presentation', file: workbench, before: '<StableWorkbenchView key={tab.id}', after: '<StableWorkbenchView key={targetId ?? tab.id}' },
  { label: 'restart-zone-reference-erased', file: store, before: 'surveyZoneSelection: restoredSurveyZoneSelection(persisted.surveyZoneSelection)', after: 'surveyZoneSelection: null' },
  { label: 'topic-discovery-error-hidden-by-save', file: survey, before: '{topicSnapshot?.error ? <div>{topicSnapshot.error}</div> : null}', after: 'null' }
]
const selectedMutations = mutations.filter(mutation => (!only || only.has(mutation.label)) && (sidebarSlice ? mutation.slice === 'sidebar' : mutation.slice !== 'sidebar') && (!process.argv.includes('--region-only') || mutation.label === 'direct-region-paints-parent-tab') && (!process.argv.includes('--placement-only') || mutation.label === 'same-address-replaced-slot-loses-content') && (!process.argv.includes('--catalog-only') || mutation.label === 'session-status-rebuilds-spatial-directory'))
const sources = [app, survey, workbench, projection, store, `${renderer}lib/survey-workface.ts`, `${renderer}lib/survey-sidebar-width.ts`, `${renderer}lib/workbench-presentation.ts`, `${renderer}components/StableWorkbenchView.tsx`, `${renderer}components/SurveyTopicRelations.tsx`, `${renderer}components/SurveyZoneItem.tsx`, `${renderer}styles/survey.css`, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/scripts/verify-survey-browser-workface-mutations.mjs']
const inputs = [...new Set([...sources, ...tests])]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const receipt = { schema: 'agentmux.renderer-source-mutation.v1', passed: false, sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
let observedSource = null
const run = async label => {
  await writeFile(join(copy, 'current-load.json'), JSON.stringify(observedSource ? { file: join(copy, observedSource), load: join(evidence, `${label}-loaded.json`) } : null))
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', ...tests, '--config', 'vitest.survey.mts', '--maxWorkers=1'], { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { code: result.code, signal: result.signal, output: result.output, log: `${label}.log` }
}
try {
  await mkdir(evidence, { recursive: true })
  assert.ok(selectedMutations.length > 0, 'The requested mutation selection must not be empty.')
  if (only) assert.deepEqual([...only].sort(), selectedMutations.map(mutation => mutation.label).sort(), 'Every --only name must match the actual selected mutation source.')
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts']) await cp(join(root, file), join(copy, file))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await symlink(join(root, 'packages'), join(copy, 'packages'))
  await mkdir(join(copy, 'apps/desktop/src'), { recursive: true })
  for (const directory of ['renderer', 'shared']) await cp(join(root, 'apps/desktop/src', directory), join(copy, 'apps/desktop/src', directory), { recursive: true })
  for (const file of ['package.json', 'tsconfig.json']) await cp(join(root, 'apps/desktop', file), join(copy, 'apps/desktop', file))
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  await symlink(join(root, 'apps/desktop/resources'), join(copy, 'apps/desktop/resources'))
  for (const [file, bytes] of original) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
  await writeFile(join(copy, 'vitest.survey.mts'), `import { defineConfig } from 'vitest/config';
import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
export default defineConfig({ server: { fs: { allow: ${JSON.stringify([root, copy])} } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
plugins: [{ name: 'actual-private-source-load', enforce: 'pre', transform(source, id) { const target = JSON.parse(readFileSync(${JSON.stringify(join(copy, 'current-load.json'))}, 'utf8')); if (target && id === target.file) writeFileSync(target.load, JSON.stringify({ file: id, sha256: createHash('sha256').update(source).digest('hex') })); } }],
test: { include: ${JSON.stringify(tests)}, setupFiles: ['vitest.setup.ts'], globalSetup: [${JSON.stringify(join(root, 'vitest.dist-freshness.ts'))}] } });\n`)

  const baseline = await run('baseline-green'); assert.equal(baseline.code, 0, baseline.output)
  for (const mutation of selectedMutations) {
    const source = original.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length - 1, 1, `Unique actual Source anchor: ${mutation.label}`)
    observedSource = mutation.file
    try {
      await writeFile(join(copy, mutation.file), source.replace(mutation.before, mutation.after))
      const red = await run(`${mutation.label}-red`)
      assert.ok(red.code > 0 && red.signal === null, red.output); assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      const loaded = JSON.parse(await readFile(join(evidence, `${mutation.label}-red-loaded.json`), 'utf8'))
      assert.equal(loaded.file, join(copy, mutation.file)); assert.equal(loaded.sha256, digest(source.replace(mutation.before, mutation.after)))
      receipt.cases.push({ ...mutation, exit: red.code, log: red.log, loaded })
    } finally { await writeFile(join(copy, mutation.file), original.get(mutation.file)) }
    const restored = await run(`${mutation.label}-restore-green`); assert.equal(restored.code, 0, restored.output)
    const loaded = JSON.parse(await readFile(join(evidence, `${mutation.label}-restore-green-loaded.json`), 'utf8')); assert.equal(loaded.sha256, digest(original.get(mutation.file)))
    receipt.cases.at(-1).restore = { exit: restored.code, log: restored.log, loaded }
    console.log(`PASS ${mutation.label}: actual AssertionRED -> restoreGREEN`)
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore); receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally { await rm(copy, { recursive: true, force: true }); receipt.cleanup = { copyRemoved: true }; await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`) }
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
}
