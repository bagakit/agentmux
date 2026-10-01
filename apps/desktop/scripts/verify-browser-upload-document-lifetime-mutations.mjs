import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = join(root, '.tmp/browser-upload-document-lifetime', ("mutations-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(output, { recursive: true })
const blocks = [
  {
    "name": "metadata-before-assignment",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "sends no irreversible assignment",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        "      await durableWriteFile(join(selection.directory, metadataName), JSON.stringify({ version: 1,\n        workspaceId: selection.workspaceId, browserId: selection.browserId, navigationId: selection.navigationId,\n        operationId: selection.operationId, documentSurvivesClient: selection.documentSurvivesClient, bytes: selection.bytes, files: selection.files }))\n",
        "      void selection\n"
      ]
    ]
  },
  {
    "name": "independent-dispose",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "keeps an independent document readable",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        ".filter(selection => !selection.documentSurvivesClient)",
        ".filter(selection => true)"
      ]
    ]
  },
  {
    "name": "independent-recovery",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "keeps an independent document readable",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        "if (data && !data.documentSurvivesClient)",
        "if (data)"
      ]
    ]
  },
  {
    "name": "exact-document-epoch",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "releases only the confirmed original browser",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        ".filter(selection => selection.navigationId === navigationId)",
        ".filter(selection => true)"
      ]
    ]
  },
  {
    "name": "person-cancellation",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "keeps files on person cancellation",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        "if (!accepted || selection.released ||",
        "if (selection.released ||"
      ]
    ]
  },
  {
    "name": "old-confirmation-lease",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "does not let a late old confirmation",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        "if (!accepted || selection.released || !this.selections.get(selection.browserId)?.has(selection)) return false",
        "if (!accepted) return false"
      ]
    ]
  },
  {
    "name": "recovery-selection-budget",
    "path": "apps/desktop/src/main/browser-uploads.ts",
    "pattern": "recovers the original 128-selection bound",
    "tests": [
      "apps/desktop/test/browser-upload-document-lifetime.test.ts"
    ],
    "edits": [
      [
        "if (this.selectionCount >= MAX_SELECTIONS)",
        "if (false)"
      ],
      [
        "if (this.disposed || this.selectionCount >= MAX_SELECTIONS)",
        "if (this.disposed)"
      ]
    ]
  },
  {
    "name": "actual-dispatch-lifetime",
    "path": "apps/desktop/src/main/browser-external-owner.ts",
    "pattern": "independent-document fact",
    "tests": [
      "apps/desktop/test/browser-external-target.test.ts"
    ],
    "edits": [
      [
        "documentSurvivesClient: true",
        "documentSurvivesClient: false"
      ]
    ]
  },
  {
    "name": "same-document-keeps-epoch",
    "path": "apps/desktop/browser-extension/service-worker.js",
    "pattern": "ends only the original replaced or closed",
    "tests": [
      "apps/desktop/test/browser-external-target.test.ts"
    ],
    "edits": [
      [
        "if (method === 'Page.frameNavigated') grant.navigationId",
        "grant.navigationId"
      ]
    ]
  },
  {
    "name": "native-confirmation-cancel",
    "path": "apps/desktop/src/main/ipc.ts",
    "pattern": "actual local native confirmation",
    "tests": [
      "apps/desktop/test/browser-external-main-glue.test.ts"
    ],
    "edits": [
      [
        "answer.response === 1",
        "answer.response >= 0"
      ]
    ]
  },
  {
    "name": "cleanup-trusted-sender",
    "path": "apps/desktop/src/main/ipc.ts",
    "pattern": "actual local native confirmation",
    "tests": [
      "apps/desktop/test/browser-external-main-glue.test.ts"
    ],
    "edits": [
      [
        "requireTrustedSender('browser:discardRetainedUpload', event)",
        "void event"
      ]
    ]
  }
]
const selected = process.argv.find(value => value.startsWith('--blocks='))?.slice('--blocks='.length).split(',')
const chosenBlocks = selected ? blocks.filter(block => selected.includes(block.name)) : blocks
if (!chosenBlocks.length || (selected && chosenBlocks.length !== selected.length)) throw new Error('Unknown or empty mutation block selection.')
const originals = new Map()
for (const block of chosenBlocks) if (!originals.has(block.path)) originals.set(block.path, await readFile(join(root, block.path), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-upload-document-lifetime-source-mutations.v1', sourceOnly: true,
  nativePassed: false, files: [...originals].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
  command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/browser-upload-document-lifetime/vitest.owning.config.mts',
    'apps/desktop/test/browser-upload-document-lifetime.test.ts', '--maxWorkers=1'],
  environment: { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' }, attempts: [], passed: false }
const run = (name, block) => {
  const command = block?.tests ? receipt.command.flatMap(item => item === 'apps/desktop/test/browser-upload-document-lifetime.test.ts' ? block.tests : [item]) : [...receipt.command]
  if (block?.pattern) command.push('-t', block.pattern)
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', timeout: 40_000,
    env: { ...process.env, ...receipt.environment }, maxBuffer: 2 * 1024 * 1024 })
  return { result, text: `${result.stdout ?? ''}${result.stderr ?? ''}`, name, command }
}
const baseline = run('baseline')
await writeFile(join(output, 'baseline.log'), baseline.text)
if (baseline.result.status !== 0) throw new Error(`Source baseline failed; retained ${output}`)
for (const block of chosenBlocks) {
  const path = join(root, block.path)
  const original = originals.get(block.path)
  if (await readFile(path, 'utf8') !== original) throw new Error(`Source changed outside this mutation: ${block.path}`)
  let mutant = original
  for (const [before, after] of block.edits) {
    if (mutant.split(before).length !== 2) throw new Error(`Mutation anchor is not unique: ${block.name}`)
    mutant = mutant.replace(before, after)
  }
  let attempt
  await writeFile(path, mutant)
  try {
    const red = run(block.name, block)
    await writeFile(join(output, `${block.name}.red.log`), red.text)
    attempt = { name: block.name, path: block.path, mutantSha256: sha(mutant), command: red.command, exit: red.result.status,
      assertionRed: red.result.status !== null && red.result.status !== 0 && /AssertionError/.test(red.text), restoredGreen: false }
  } finally {
    if (await readFile(path, 'utf8') !== mutant) throw new Error(`Concurrent Source change retained; refused overwrite: ${block.path}`)
    await writeFile(path, original)
  }
  const restored = run(`${block.name}.restore`, block)
  await writeFile(join(output, `${block.name}.restore.log`), restored.text)
  attempt.restoredGreen = restored.result.status === 0
  receipt.attempts.push(attempt)
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (!attempt.assertionRed || !attempt.restoredGreen) throw new Error(`Mutation not proved: ${block.name}; retained ${output}`)
  process.stdout.write(`${block.name}: Assertion RED -> restored GREEN\n`)
}
for (const [path, bytes] of originals) if (await readFile(join(root, path), 'utf8') !== bytes) throw new Error(`Final Source drift: ${path}`)
receipt.passed = true
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(`${output}\n`)
