import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { capturePrimaryReading } from '../a2a-primary-reading/capture.mjs'

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Seven original reading faces, using current product components and controlled IO leaves. */
export async function captureA2aReferenceReading({ root, evidence, styleMutation = process.env.AGENTMUX_A2A_REFERENCE_STYLE_MUTATION }) {
  assert.ok(!styleMutation || styleMutation === 'timing-fixed-row', 'Only the original notification timing row can be mutated')
  root = resolve(root); evidence = resolve(evidence); await mkdir(evidence, { recursive: true })
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const scene = resolve(evidence, 'scene.json'), log = resolve(evidence, 'scene.log')
  const test = 'apps/desktop/test/a2a-primary-reading-consumers.test.tsx'
  try {
    const result = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/scripts/fixtures/a2a-reference-reading/vitest.scene.config.mts', test, '-t',
      'exports actual journal and public Reader metadata variants for all product consumers'],
    { cwd: root, env: { ...process.env, AGENTMUX_MESSAGE_METADATA_SCENE: scene }, maxBuffer: 8 * 1024 * 1024 })
    await writeFile(log, result.stdout + result.stderr)
  } catch (error) { await writeFile(log, (error.stdout ?? '') + (error.stderr ?? '')); throw error }
  const facts = JSON.parse(await readFile(scene, 'utf8'))
  assert.equal(facts.scenarios.idle.originals.length, 2)
  const capture = await capturePrimaryReading({ root, evidence, scene, fixtureDirectory: import.meta.dirname, expectedFrames: 7,
    ...(styleMutation ? { transformStyles(styles) {
      const path = 'packages/client-ui/src/styles/conversation-a2a.css'; let changes = 0
      styles.walkRules('.conversation-a2a-timing', rule => {
        if (resolve(rule.source.input.file) !== resolve(root, path)) return
        rule.walkDecls('grid-row', declaration => { assert.equal(declaration.value, 'auto'); declaration.value = '2'; changes++ })
      })
      if (!changes) return
      assert.equal(changes, 1, 'One actual notification timing row is mutated')
      return { path, mutation: styleMutation, before: 'auto', after: '2', changes, stage: 'postcss-product-stylesheet' }
    } } : {}),
    requiredConsumers: ['apps/desktop/src/renderer/src/components/ActivityView.tsx',
      'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
      'packages/client-ui/src/components/InputMailboxRecords.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
      'packages/client-ui/src/components/ConversationA2AReferences.tsx', 'packages/client-ui/src/components/ConversationNotificationDetails.tsx',
      'packages/client-ui/src/styles/conversation-message.css'] })
  capture.schema = 'agentmux.a2a-reference-reading-capture.v1'
  capture.sourceCommit = sourceCommit
  capture.boundary = 'Current production ActivityView and SessionMailbox in a private Renderer. Original notice and message DTOs come from the actual journal and public Core Reader; Renderer IO, mailbox input leaves and clipboard writes are controlled. No installed App, model, user Session or system clipboard is operated. Public CLI and registered IPC are separately verified.'
  capture.inputs = Object.fromEntries(Object.entries(capture.inputs).map(([file, sha256]) => [file, { sha256 }]))
  for (const file of [test, 'apps/desktop/test/helpers/a2a-primary-reading-fixture.ts',
    'apps/desktop/test/vitest.a2a-message-metadata.config.mts', 'apps/desktop/scripts/fixtures/a2a-primary-reading/capture.mjs'])
    capture.inputs[file] = { sha256: hash(await readFile(resolve(root, file))) }
  capture.frames = capture.render.frames.map(frame => ({ ...frame, path: resolve(evidence, frame.file) }))
  capture.scene = { file: relative(root, scene), sha256: hash(await readFile(scene)) }
  await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(capture, null, 2) + '\n')
  return capture
}
