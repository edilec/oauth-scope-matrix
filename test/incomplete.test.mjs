import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditScopeMatrix } from '../src/index.mjs'
import { apiReport, cliReport, clean, client, findingsFor, fixture, operation, scope } from './support.mjs'

/**
 * Every place this package decides a run is incomplete, pinned one at a time.
 *
 * A sibling tool in this catalog had an `incomplete = true` deleted and its
 * entire suite stayed green, because a second flag was setting it for the same
 * input. Each case below is built so that exactly one of the twelve flags fires,
 * and asserts the status and the process exit code -- so deleting that one line
 * fails this file rather than passing quietly.
 *
 * Each case also records what the run would say without its flag, which is the
 * question the report contract actually asks. In this package every flag is
 * accompanied by an error-severity finding, so removing one turns `incomplete`
 * into `fail` rather than into `pass` -- a weaker failure than the catalog's
 * worst case and still a wrong answer: exit 2 means "this run could not
 * conclude" and exit 1 means "it concluded, and the answer is no". The last test
 * in this file pins that property itself, so it cannot quietly stop being true.
 */

const at = (root, name) => join(root, name)

test('(1) an input that could not be resolved', async () => {
  const { code, report } = await cliReport({
    'clients.json': clean()['clients.json'],
    'operations.json': clean()['operations.json'],
  })

  assert.equal(findingsFor(report, 'input-unreadable').length, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(1) an input that resolves outside the root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'oauth-scope-matrix-outside-'))
  const root = await mkdtemp(join(tmpdir(), 'oauth-scope-matrix-root-'))
  try {
    await writeFile(at(outside, 'planted.json'), JSON.stringify({ schemaVersion: '1', scopes: [] }))
    for (const [name, document] of Object.entries(clean())) {
      if (name === 'scopes.json') continue
      await writeFile(at(root, name), JSON.stringify(document))
    }
    await symlink(at(outside, 'planted.json'), at(root, 'scopes.json'))

    const report = await auditScopeMatrix({ root })
    assert.equal(findingsFor(report, 'path-escapes-root').length, 1)
    assert.equal(report.status, 'incomplete')
  } finally {
    await rm(outside, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('(2) bytes that could not be decoded or parsed', async () => {
  const undecodable = await cliReport({ ...clean(), 'scopes.json': new Uint8Array([0xff]) })
  assert.equal(findingsFor(undecodable.report, 'input-not-utf8').length, 1)
  assert.equal(undecodable.report.status, 'incomplete')
  assert.equal(undecodable.code, 2)

  const unparseable = await cliReport({ ...clean(), 'scopes.json': '{' })
  assert.equal(findingsFor(unparseable.report, 'input-not-json').length, 1)
  assert.equal(unparseable.report.status, 'incomplete')
  assert.equal(unparseable.code, 2)
})

test('(3) a document whose shape or version this build cannot take', async () => {
  const { code, report } = await cliReport({
    ...clean(),
    'scopes.json': { schemaVersion: '2', scopes: [] },
  })

  assert.equal(findingsFor(report, 'schema-version-unsupported').length, 1)
  assert.equal(report.summary.scopes, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(4) an entry that was refused while the rest of the document compiled', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held'), 'not an object'],
    [client('one', ['held'])],
    [operation('op', ['held'])],
  ))

  assert.equal(findingsFor(report, 'scope-invalid').length, 1)
  assert.equal(report.summary.scopes, 1, 'one entry of two compiled, so part of the document was never compared')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(5) a reference that was refused inside an entry that otherwise compiled', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held')],
    [client('one', ['held', 'catalog.*'])],
    [operation('op', ['held'])],
  ))

  assert.equal(findingsFor(report, 'scope-pattern-unsupported').length, 1)
  assert.equal(report.summary.clients, 1, 'the client compiled; one of its grants did not')
  assert.equal(report.summary.covered, 1, 'and the operation is still covered, so nothing else marks this run')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(6) an implication chain the walk stopped short of', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('s0', ['s1']), scope('s1', ['s2']), scope('s2')],
    [client('one', ['s0']), client('deep', ['s2'])],
    [operation('op', ['s1']), operation('two', ['s2'])],
  ), ['--max-implication-depth', '1'])

  assert.equal(findingsFor(report, 'implication-depth-exceeded').length, 1)
  assert.equal(report.summary.covered, 2, 'both operations are covered, so coverage is not what marks this run')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(7) an implication to a scope the catalog does not declare', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held', ['ghost'])],
    [client('one', ['held'])],
    [operation('op', ['held'])],
  ))

  assert.equal(findingsFor(report, 'scope-implication-unknown').length, 1)
  assert.equal(report.summary.covered, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(8) an operation whose requirement could not be decided', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held')],
    [client('one', ['held'])],
    [operation('op', ['held']), operation('mystery', ['ghost'])],
  ))

  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.summary.checked, 1, 'one operation was evaluated, so this is not the vacuous-pass guard')
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(9) a grant this run could not describe', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held')],
    [client('one', ['held', 'legacy.everything'])],
    [operation('op', ['held'])],
  ))

  assert.equal(findingsFor(report, 'grant-scope-unknown').length, 1)
  assert.equal(report.summary.unevaluated, 0, 'every operation was decided, so flag (8) is not what marks this run')
  assert.equal(report.summary.covered, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('(10) the vacuous pass: three documents that compile and nothing to evaluate', async () => {
  const { code, report } = await cliReport(fixture([scope('held')], [client('one', ['held'])], []))

  assert.equal(findingsFor(report, 'no-operations-evaluated').length, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.unevaluated, 0)
  assert.equal(report.status, 'incomplete', 'pass with checked 0 would be green on no evidence at all')
  assert.equal(code, 2)
})

test('(11) a comparison that stopped on its time budget', async () => {
  let ticks = 0
  const report = await apiReport(clean(), { clock: () => (ticks++ === 0 ? 0 : 5000), limits: { maxRuntimeMs: 1 } })

  assert.equal(findingsFor(report, 'time-budget-exceeded').length, 1)
  assert.equal(report.status, 'incomplete')
})

test('(12) a report the finding limit truncated', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('a1'), scope('a2'), scope('a3')],
    [client('one', [])],
    [operation('op', [])],
  ), ['--max-findings', '2'])

  assert.equal(findingsFor(report, 'too-many-findings').length, 1)
  assert.equal(report.findings.length, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
})

test('every incomplete run carries at least one error, so no flag is the only thing between it and a pass', async () => {
  const corpus = [
    () => apiReport({ 'clients.json': clean()['clients.json'], 'operations.json': clean()['operations.json'] }),
    () => apiReport({ ...clean(), 'scopes.json': new Uint8Array([0xff]) }),
    () => apiReport({ ...clean(), 'scopes.json': '{' }),
    () => apiReport({ ...clean(), 'scopes.json': { schemaVersion: '2', scopes: [] } }),
    () => apiReport(fixture([scope('held'), 'x'], [client('one', ['held'])], [operation('op', ['held'])])),
    () => apiReport(fixture([scope('held')], [client('one', ['held', 'a.*'])], [operation('op', ['held'])])),
    () => apiReport(fixture([scope('held', ['ghost'])], [client('one', ['held'])], [operation('op', ['held'])])),
    () => apiReport(fixture([scope('held')], [client('one', ['held'])], [operation('op', ['ghost'])])),
    () => apiReport(fixture([scope('held')], [client('one', ['held', 'ghost'])], [operation('op', ['held'])])),
    () => apiReport(fixture([scope('held')], [client('one', ['held'])], [])),
    () => apiReport(clean(), { clock: (() => { let n = 0; return () => (n++ === 0 ? 0 : 5000) })(), limits: { maxRuntimeMs: 1 } }),
    () => apiReport(fixture([scope('a1'), scope('a2'), scope('a3')], [client('one', [])], [operation('op', [])]), { limits: { maxFindings: 2 } }),
  ]

  let seen = 0
  for (const build of corpus) {
    const report = await build()
    assert.equal(report.status, 'incomplete', 'every case in this corpus must be incomplete')
    assert.equal(report.summary.errors > 0, true, 'an incomplete run always names an error-severity reason')
    seen += 1
  }
  assert.equal(seen, 12)
})
