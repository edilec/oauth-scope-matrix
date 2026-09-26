import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditScopeMatrix, isInside } from '../src/index.mjs'
import { clean, client, findingsFor, fixture, operation, scope } from './support.mjs'

/**
 * Confinement, and the two ways a lexical check gets it wrong.
 *
 * Refusing `..` and absolute paths is not confinement: a symbolic link planted
 * inside the root contains no `..` at all and points anywhere. Comparing a real
 * path against an unresolved root is not confinement either -- it refuses
 * legitimate files whenever the root itself is reached through a link, which on
 * macOS is every temporary directory.
 */

async function withTree(body) {
  const base = await mkdtemp(join(tmpdir(), 'oauth-scope-matrix-confine-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function writeMatrix(directory, files) {
  for (const [name, document] of Object.entries(files)) {
    await writeFile(join(directory, name), `${JSON.stringify(document, null, 2)}\n`)
  }
}

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/inner.json'), true)
  assert.equal(isInside('/a/root', '/a/rootlike/inner.json'), false)
  assert.equal(isInside('/a/root/', '/a/root/inner.json'), true)
})

test('a symlink planted inside the root is refused, and out-of-root content is not echoed', async () => {
  await withTree(async (base) => {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeMatrix(root, { 'clients.json': clean()['clients.json'], 'operations.json': clean()['operations.json'] })
    await writeFile(join(outside, 'secrets.json'), JSON.stringify({
      schemaVersion: '1',
      scopes: [{ id: 'planted.scope', description: 'PLANTED_MARKER' }],
    }))
    await symlink(join(outside, 'secrets.json'), join(root, 'scopes.json'))

    const report = await auditScopeMatrix({ root })

    const finding = findingsFor(report, 'path-escapes-root')[0]
    assert.equal(finding.location.file, 'scopes.json')
    assert.equal(finding.message.includes('refused unread'), true)
    assert.equal(JSON.stringify(report).includes('PLANTED_MARKER'), false, 'nothing from outside the root reached the report')
    assert.equal(JSON.stringify(report).includes('planted.scope'), false)
    assert.equal(report.status, 'incomplete')
  })
})

test('a legitimate file reached through a symlinked root is not refused', async () => {
  await withTree(async (base) => {
    const real = join(base, 'real')
    const linked = join(base, 'linked')
    await mkdir(real)
    await writeMatrix(real, clean())
    await symlink(real, linked)

    const report = await auditScopeMatrix({ root: linked })

    assert.deepEqual(report.findings, [], 'a false refusal is a defect too')
    assert.equal(report.status, 'pass')
  })
})

test('a link that resolves nowhere is unreadable rather than refused as an escape', async () => {
  await withTree(async (base) => {
    const root = join(base, 'root')
    await mkdir(root)
    await writeMatrix(root, { 'clients.json': clean()['clients.json'], 'operations.json': clean()['operations.json'] })
    await symlink(join(root, 'missing.json'), join(root, 'scopes.json'))

    const report = await auditScopeMatrix({ root })

    const finding = findingsFor(report, 'input-unreadable')[0]
    assert.equal(finding.location.file, 'scopes.json')
    assert.equal(report.status, 'incomplete')
  })
})

test('a missing file under a symlinked parent is confined by the parent, not by where it would have been', async () => {
  await withTree(async (base) => {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeMatrix(root, { 'clients.json': clean()['clients.json'], 'operations.json': clean()['operations.json'] })
    await symlink(outside, join(root, 'elsewhere'))

    const report = await auditScopeMatrix({ root, scopes: 'elsewhere/scopes.json' })

    assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'elsewhere/scopes.json')
    assert.equal(report.status, 'incomplete')
  })
})

test('a directory named as an input is not a regular file and is reported as unread', async () => {
  await withTree(async (base) => {
    const root = join(base, 'root')
    await mkdir(root)
    await mkdir(join(root, 'scopes.json'))
    await writeMatrix(root, { 'clients.json': clean()['clients.json'], 'operations.json': clean()['operations.json'] })

    const report = await auditScopeMatrix({ root })

    assert.equal(findingsFor(report, 'input-unreadable')[0].message.includes('not a regular file'), true)
    assert.equal(report.status, 'incomplete')
  })
})

test('a root that is not a directory is a configuration error, not a finding', async () => {
  await withTree(async (base) => {
    const file = join(base, 'not-a-directory')
    await writeFile(file, '{}')

    await assert.rejects(() => auditScopeMatrix({ root: file }), /--root must be a directory/)
    await assert.rejects(() => auditScopeMatrix({ root: join(base, 'nowhere') }), /--root could not be resolved/)
  })
})

/**
 * Path identity, for a tool that writes nothing.
 *
 * A sibling tool in this catalog destroyed its own input because it compared
 * real paths to decide whether a destination was also an input, and a hard link
 * gives one inode two names that both resolve to themselves. This tool has no
 * destination at all: it opens three files for reading and creates, truncates
 * and renames nothing. The property is worth pinning rather than asserting,
 * because "read-only" is exactly the kind of claim that stops being true
 * quietly, so the case below hard-links one document to a second name, runs the
 * tool over both, and then compares the tree byte for byte.
 */
test('the run reads and never writes, even when two names share one inode', async () => {
  await withTree(async (base) => {
    const root = join(base, 'root')
    await mkdir(root)
    await writeMatrix(root, fixture(
      [scope('catalog.read')],
      [client('one', ['catalog.read'])],
      [operation('list', ['catalog.read'])],
    ))
    await link(join(root, 'scopes.json'), join(root, 'also-scopes.json'))

    const before = new Map()
    for (const name of (await readdir(root)).sort()) {
      const info = await stat(join(root, name))
      before.set(name, { bytes: await readFile(join(root, name), 'utf8'), size: info.size, ino: info.ino })
    }

    const first = await auditScopeMatrix({ root })
    const second = await auditScopeMatrix({ root, scopes: 'also-scopes.json' })

    assert.equal(first.status, 'pass')
    assert.equal(second.status, 'pass')
    assert.equal(before.get('scopes.json').ino, before.get('also-scopes.json').ino, 'one inode, two names')

    const names = (await readdir(root)).sort()
    assert.deepEqual(names, ['also-scopes.json', 'clients.json', 'operations.json', 'scopes.json'])
    for (const name of names) {
      const info = await stat(join(root, name))
      assert.equal(await readFile(join(root, name), 'utf8'), before.get(name).bytes, `${name} was not rewritten`)
      assert.equal(info.size, before.get(name).size)
      assert.equal(info.ino, before.get(name).ino, `${name} was not replaced`)
    }
  })
})
