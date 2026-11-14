import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const scrollBarNotice = {
  package: 'react-remove-scroll-bar@2.3.8',
  archive: 'https://registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz',
  source: 'https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE',
  sha256: 'a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84'
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function licenseFor(root) {
  const { name, version, license, author } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const id = `${name}@${version}`
  assert.ok(['ISC', 'MIT', '0BSD'].includes(license), 'Review archive license for ' + id)
  const files = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() &&
    /^(?:licen[sc]e|notice|copying|copyrightnotice)(?:[.-]|$)/iu.test(entry.name)).map(entry => entry.name).sort()
  if (files.length) {
    const texts = await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')]))
    return { id, license, texts, origin: 'Included in the installed npm artifact.' }
  }
  assert.equal(id, scrollBarNotice.package, 'No copyright notice found for ' + id)
  assert.match(typeof author === 'string' ? author : author?.name ?? '', /Anton Korzunov/u)
  const reply = await fetch(scrollBarNotice.source, { signal: AbortSignal.timeout(15_000) })
  assert.ok(reply.ok, 'Cannot retrieve the pinned upstream scrollbar copyright notice')
  const text = await reply.text()
  assert.equal(digest(text), scrollBarNotice.sha256)
  return {
    id, license, texts: [['LICENSE', text]],
    origin: `The [npm artifact](${scrollBarNotice.archive}) declares MIT and names Anton Korzunov. It lacks a license file. The [official repository notice](${scrollBarNotice.source}) is from a different upstream revision. The exact release source has not been verified.`
  }
}

export async function writeNotices(directory, packageRoots, glyphs, patches) {
  const records = await Promise.all([...new Set(packageRoots)].map(licenseFor))
  const distinct = new Map()
  for (const record of records) {
    if (distinct.has(record.id)) assert.deepEqual(distinct.get(record.id), record)
    distinct.set(record.id, record)
  }
  const packages = [...distinct.values()].sort((left, right) => left.id.localeCompare(right.id))
  const provenance = {
    status: 'private qualification',
    artwork: { included: 'Authored vector drawings and Lucide geometry in the semantic glyph catalog.',
      source: 'theme/icon-glyphs.ts', sha256: digest(glyphs), excluded: ['brand files', 'provider portraits', 'fonts'] },
    patches,
    bundled: packages.map(({ id, license, texts, origin }) => ({ id, license, origin,
      notices: Object.fromEntries(texts.map(([name, body]) => [name, digest(body)])) }))
  }
  const sections = packages.map(({ id, license, origin, texts }) => [
    `## ${id}`, license, origin, ...texts.flatMap(([name, body]) => [`### ${name}`, body.trimEnd()])
  ].join('\n\n'))
  await writeFile(join(directory, 'THIRD_PARTY_NOTICES.md'), [
    '# Third-party notices',
    'This private archive includes compiled dependencies, authored vector drawings and Lucide geometry. See `PROVENANCE.json` for the included dependency versions and local patch identities.',
    ...sections
  ].join('\n\n') + '\n')
  await writeFile(join(directory, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n')
  return provenance
}
