import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory, raisedRules } from './support.mjs'

/**
 * The shipped examples, run as the README says to run them.
 *
 * `npm run example` is part of `npm run check`, so the clean example failing
 * would already break the build. These cases add the two that are supposed to
 * be broken -- an example whose output nobody asserts is an example that stops
 * matching the tool it documents.
 */

async function example(name, extraArgs = []) {
  const root = join(projectDirectory, 'examples', name)
  const result = await cliRun(['--root', root, '--json', ...extraArgs])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

test('every example directory holds exactly the three documents', async () => {
  for (const name of ['broken', 'clean', 'incomplete']) {
    const entries = (await readdir(join(projectDirectory, 'examples', name))).sort()
    assert.deepEqual(entries, ['clients.json', 'operations.json', 'scopes.json'])
  }
})

test('the clean example passes with nothing to report', async () => {
  const { code, report } = await example('clean')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 5)
  assert.equal(report.summary.covered, 5)
  assert.equal(report.summary.extraGrants, 0)
})

test('in the clean example no operation requires anything it does not need', async () => {
  const { report } = await example('clean')

  for (const row of report.matrix.operations) {
    assert.deepEqual(row.leastRequired, row.requires, `${row.id} requires nothing it does not need`)
    assert.equal(row.status, 'covered')
  }
  assert.deepEqual(
    report.matrix.clients.map((client) => client.id),
    ['backoffice', 'storefront-web'],
  )
})

test('the broken example completes and fails, with a verdict rather than a gap', async () => {
  const { code, report } = await example('broken')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.deepEqual(raisedRules(report), ['operation-uncovered', 'requirement-redundant', 'scope-reference-duplicate'])
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.uncovered, 1)
  assert.equal(report.summary.unevaluated, 0, 'nothing here is unknown; it is simply wrong')
})

test('the broken example reports the smaller least-required set it found', async () => {
  const { report } = await example('broken')
  const row = report.matrix.operations.find((operation) => operation.id === 'update-catalog-item')

  assert.deepEqual(row.requires, ['catalog.read', 'catalog.write'])
  assert.deepEqual(row.leastRequired, ['catalog.write'])
  assert.equal(row.status, 'uncovered')
})

test('the incomplete example is incomplete, and neither unknown scope is assumed safe', async () => {
  const { code, report } = await example('incomplete')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['grant-scope-unknown', 'requirement-scope-unknown', 'scope-unused'])
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.summary.checked, 1)

  const client = report.matrix.clients.find((row) => row.id === 'storefront-web')
  assert.deepEqual(client.granted, ['catalog.read'], 'the undeclared grant is not in the effective set')
  assert.equal(client.effective.includes('legacy.everything'), false)

  const operation = report.matrix.operations.find((row) => row.id === 'export-catalog')
  assert.equal(operation.status, 'unevaluated')
  assert.equal(operation.leastRequired, null, 'no least-required set is invented for a requirement nobody can resolve')
})
