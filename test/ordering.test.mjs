import assert from 'node:assert/strict'
import test from 'node:test'

import { auditScopeMatrix, validateLimits } from '../src/index.mjs'
import {
  apiReport,
  client,
  clientDocument,
  clientRow,
  findingsFor,
  fixture,
  operation,
  operationDocument,
  operationRow,
  scope,
  scopeDocument,
} from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running. Pinning the comparator itself is no better -- every call site can be
 * swapped on its own, and there are twenty-seven of them in this package.
 *
 * Every case below chooses inputs an English collator orders the other way
 * round, pushes them through the real report path, and asserts the exact
 * emitted sequence, so that swapping any one site fails a test rather than
 * going unnoticed. The collator is constructed here and asserted to disagree,
 * which is what makes these cases cases at all.
 *
 * Three sites cannot be pinned this way because their real values -- rule ids
 * over [a-z-], JSON Pointers over [a-z0-9/], and this package's own limit names
 * -- collate identically to their code points. Those are proved equivalent by
 * enumeration in `test/ordering-equivalence.test.mjs` rather than left as gaps.
 */

const collator = new Intl.Collator('en')
const disagrees = (left, right) => {
  assert.equal(left < right, true, `${left} precedes ${right} by code unit`)
  assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is what makes this a case`)
}

test('the disagreements every case below relies on are real', () => {
  disagrees('README', 'assets')
  disagrees('Z-top', 'a-low')
  disagrees('Z-scope', 'a-scope')
  disagrees('Zed', 'alpha')
  disagrees('Z.json', 'a.json')
})

test('every array in the matrix is ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-top', ['a-low']), scope('a-low'), scope('README'), scope('assets'), scope('Z-spare'), scope('a-spare')],
    [
      client('Z-client', ['Z-top', 'README', 'assets']),
      client('a-client', ['a-low', 'Z-spare', 'a-spare']),
    ],
    [operation('Z-op', ['a-low']), operation('a-op', ['README', 'assets'])],
  ))

  assert.deepEqual(report.matrix.scopes, ['README', 'Z-spare', 'Z-top', 'a-low', 'a-spare', 'assets'])
  assert.deepEqual(report.matrix.clients.map((row) => row.id), ['Z-client', 'a-client'])
  assert.deepEqual(report.matrix.operations.map((row) => row.id), ['Z-op', 'a-op'])

  assert.deepEqual(operationRow(report, 'a-op').requires, ['README', 'assets'])
  assert.deepEqual(operationRow(report, 'a-op').leastRequired, ['README', 'assets'])
  assert.deepEqual(operationRow(report, 'Z-op').coveredBy, ['Z-client', 'a-client'])

  assert.deepEqual(clientRow(report, 'Z-client').granted, ['README', 'Z-top', 'assets'])
  assert.deepEqual(clientRow(report, 'Z-client').effective, ['README', 'Z-top', 'a-low', 'assets'])
  assert.deepEqual(clientRow(report, 'Z-client').covers, ['Z-op', 'a-op'])
  assert.deepEqual(clientRow(report, 'a-client').extra, ['Z-spare', 'a-spare'])

  for (const list of [
    report.matrix.scopes,
    report.matrix.clients.map((row) => row.id),
    operationRow(report, 'a-op').requires,
    clientRow(report, 'a-client').extra,
  ]) {
    assert.notDeepEqual(list, [...list].sort((left, right) => collator.compare(left, right)), 'a collator would order this list differently')
  }
})

test('which of two mutually implying requirements survives is decided by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-scope', ['a-scope']), scope('a-scope', ['Z-scope'])],
    [client('one', ['Z-scope'])],
    [operation('op', ['Z-scope', 'a-scope'])],
  ))

  // Either scope alone would do, so the answer is whichever one the removal
  // pass considers first. Under collation it would be the other one, and the
  // same matrix would report a different least-required set on a different host.
  assert.deepEqual(operationRow(report, 'op').leastRequired, ['a-scope'])
  assert.equal(findingsFor(report, 'requirement-redundant')[0].message.includes('requires "Z-scope"'), true)
})

test('which kept scope is named as covering a dropped requirement is decided by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-all', ['x-low']), scope('a-all', ['x-low']), scope('x-low')],
    [client('one', ['Z-all', 'a-all'])],
    [operation('op', ['Z-all', 'a-all', 'x-low'])],
  ))

  const finding = findingsFor(report, 'requirement-redundant')[0]
  assert.equal(finding.message.includes('requires "x-low", which "Z-all" already implies'), true)
  assert.deepEqual(operationRow(report, 'op').leastRequired, ['Z-all', 'a-all'])
})

test('which grant is named as already conferring another is decided by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-all', ['x-low']), scope('a-all', ['x-low']), scope('x-low')],
    [client('one', ['Z-all', 'a-all', 'x-low'])],
    [operation('op', ['Z-all', 'a-all'])],
  ))

  const finding = findingsFor(report, 'grant-implied-by-another')[0]
  assert.equal(finding.location.pointer, '/clients/0/scopes/2')
  assert.equal(finding.message.includes('granted "x-low" and also "Z-all"'), true)
})

test('which member of a mutually implying pair of grants is kept is decided by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-scope', ['a-scope']), scope('a-scope', ['Z-scope'])],
    [client('one', ['Z-scope', 'a-scope'])],
    [operation('op', ['Z-scope'])],
  ))

  const findings = findingsFor(report, 'grant-implied-by-another')
  assert.equal(findings.length, 1, 'exactly one of the pair is reported, or the advice would be to revoke both')
  assert.equal(findings[0].location.pointer, '/clients/0/scopes/1')
  assert.equal(findings[0].message.includes('granted "a-scope" and also "Z-scope"'), true)
  assert.equal(findingsFor(report, 'grant-unused').length, 0, 'and the kept one is not then reported as spare')
})

test('a tie for the closest client is broken by code unit, not by document order', async () => {
  const report = await apiReport(fixture(
    [scope('need-one'), scope('need-two')],
    [client('a-client', ['need-one']), client('Z-client', ['need-one'])],
    [operation('covered-op', ['need-one']), operation('op', ['need-one', 'need-two'])],
  ))

  // Both clients are missing exactly one scope, and the one declared first is
  // the collated answer; the code-unit answer is the other one.
  assert.equal(findingsFor(report, 'operation-uncovered')[0].evidence, 'closest client "Z-client" is missing: need-two')
})

test('the scope lists inside an uncovered finding are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-need'), scope('a-need'), scope('held')],
    [client('one', ['held'])],
    [operation('held-op', ['held']), operation('op', ['a-need', 'Z-need'])],
  ))

  const finding = findingsFor(report, 'operation-uncovered')[0]
  assert.equal(finding.message.includes('it requires "Z-need", "a-need"'), true)
  assert.equal(finding.evidence, 'closest client "one" is missing: Z-need, a-need')
})

test('with no client at all the required list is still ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('Z-need'), scope('a-need')],
    [],
    [operation('op', ['a-need', 'Z-need'])],
  ))

  assert.equal(findingsFor(report, 'operation-uncovered')[0].evidence, 'no client declared; required: Z-need, a-need')
})

test('a cycle is anchored and listed by code unit, whatever order it was declared in', async () => {
  const report = await apiReport(fixture(
    [scope('a-one', ['Z-one']), scope('Z-one', ['a-one'])],
    [client('one', ['Z-one'])],
    [operation('op', ['Z-one'])],
  ))

  const finding = findingsFor(report, 'scope-implication-cycle')[0]
  assert.equal(finding.evidence, 'cycle: Z-one, a-one')
  assert.equal(finding.location.pointer, '/scopes/1', 'the anchor is the first member by code unit, which is declared second')
})

test('the unknown keys named in a message are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('held'), { id: 'odd', alpha: 1, Zed: 2 }],
    [client('one', ['held'])],
    [operation('op', ['held'])],
  ))

  assert.equal(findingsFor(report, 'scope-invalid')[0].message.includes('unknown key(s) "Zed", "alpha"'), true)
})

test('which unknown limit is reported first is decided by code unit', () => {
  // Declared alpha-first on purpose: insertion order is what an unsorted walk
  // would follow, and collation would follow it too.
  assert.throws(() => validateLimits({ alpha: 1, Zed: 1 }), /Unknown limit "Zed"/)
})

test('which unknown option is reported first is decided by code unit', async () => {
  await assert.rejects(() => auditScopeMatrix({ alpha: 1, Zed: 1, root: '.' }), /Unknown option "Zed"/)
})

test('findings are ordered by file first, by the names the caller gave', async () => {
  const files = {
    'Z.json': scopeDocument([scope('spare.scope')]),
    'a.json': clientDocument([client('one', [])]),
    'operations.json': operationDocument([operation('op', [])]),
  }
  const report = await apiReport(files, { scopes: 'Z.json', clients: 'a.json' })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [
      ['Z.json', 'scope-unused'],
      ['a.json', 'client-grants-nothing'],
      ['operations.json', 'operation-requires-nothing'],
    ],
  )
  const asCollated = [...report.findings].sort((left, right) => collator.compare(left.location.file, right.location.file))
  assert.notDeepEqual(asCollated.map((finding) => finding.location.file), report.findings.map((finding) => finding.location.file))
})

test('findings sharing a file, a pointer and a rule are ordered by message, by code unit', async () => {
  const report = await apiReport(fixture(
    [scope('top', ['Z-extra', 'a-extra']), scope('Z-extra'), scope('a-extra')],
    [client('one', ['top'])],
    [operation('op', ['top', 'a-extra', 'Z-extra'])],
  ))

  const findings = findingsFor(report, 'requirement-redundant')
  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map((finding) => finding.location.pointer), ['/operations/0/requires', '/operations/0/requires'])
  assert.equal(findings[0].message.includes('requires "Z-extra"'), true)
  assert.equal(findings[1].message.includes('requires "a-extra"'), true)
  assert.equal(collator.compare(findings[0].message, findings[1].message) > 0, true, 'a collator would emit them the other way round')
})

test('the same inputs produce byte-identical stdout twice over', async () => {
  const files = fixture(
    [scope('Z-top', ['a-low']), scope('a-low'), scope('README'), scope('assets')],
    [client('Z-client', ['Z-top']), client('a-client', ['README', 'assets'])],
    [operation('Z-op', ['a-low']), operation('a-op', ['README', 'assets'])],
  )

  const first = await apiReport(files)
  const second = await apiReport(files)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
