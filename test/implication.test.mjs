import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, client, clientRow, findingsFor, fixture, operation, raisedRules, scope } from './support.mjs'

test('a declared implication expands transitively', async () => {
  const report = await apiReport(fixture(
    [scope('a.top', ['b.mid']), scope('b.mid', ['c.low']), scope('c.low')],
    [client('one', ['a.top'])],
    [operation('needs-low', ['c.low'])],
  ))

  assert.deepEqual(clientRow(report, 'one').effective, ['a.top', 'b.mid', 'c.low'])
  assert.deepEqual(report.matrix.operations[0].coveredBy, ['one'])
  assert.equal(report.summary.covered, 1)
})

/**
 * The acceptance property, stated as the tool's own behaviour.
 *
 * `repo:write` reads like a superset of `repo:read` and is not one here, and
 * that is deliberate: for real providers the string shape is not the model.
 * Google's `drive.file` does not confer `drive.readonly`; Microsoft's
 * `Files.Read.All` is not implied by `Files.ReadWrite`; a scope called
 * `admin:org` confers nothing about `repo` at all. Inferring an edge from a
 * prefix would report a permission the client does not hold.
 */
test('implication is never inferred from the shape of a name', async () => {
  const undeclared = await apiReport(fixture(
    [scope('repo:read'), scope('repo:write')],
    [client('ci', ['repo:write'])],
    [operation('read-repo', ['repo:read'])],
  ))

  assert.deepEqual(clientRow(undeclared, 'ci').effective, ['repo:write'], 'the prefix conferred nothing')
  assert.deepEqual(raisedRules(undeclared), ['grant-unused', 'operation-uncovered'])
  assert.equal(undeclared.status, 'fail', 'the operation nobody covers is a verdict, not missing evidence')

  const declared = await apiReport(fixture(
    [scope('repo:read'), scope('repo:write', ['repo:read'])],
    [client('ci', ['repo:write'])],
    [operation('read-repo', ['repo:read'])],
  ))

  assert.deepEqual(clientRow(declared, 'ci').effective, ['repo:read', 'repo:write'])
  assert.equal(declared.status, 'pass', 'the same pair, once the edge is declared')
})

test('an implication to a scope nobody declared is not followed and is not assumed safe', async () => {
  const report = await apiReport(fixture(
    [scope('a.top', ['ghost.scope']), scope('b.other')],
    [client('one', ['a.top', 'b.other'])],
    [operation('needs-top', ['a.top'])],
  ))

  const finding = findingsFor(report, 'scope-implication-unknown')[0]
  assert.equal(finding.location.file, 'scopes.json')
  assert.equal(finding.location.pointer, '/scopes/0/implies/0')
  assert.equal(finding.message.includes('the edge was not followed'), true)
  assert.deepEqual(clientRow(report, 'one').effective, ['a.top', 'b.other'], 'the unknown name confers nothing')
  assert.equal(report.status, 'incomplete', 'and an unknown is never a pass')
})

test('a scope that implies itself is reported and the edge is dropped', async () => {
  const report = await apiReport(fixture(
    [scope('a.top', ['a.top'])],
    [client('one', ['a.top'])],
    [operation('needs-top', ['a.top'])],
  ))

  const finding = findingsFor(report, 'scope-implication-self')[0]
  assert.equal(finding.location.pointer, '/scopes/0/implies/0')
  assert.deepEqual(clientRow(report, 'one').effective, ['a.top'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'pass', 'a warning alone does not fail the run')
})

test('a cycle terminates on the visited set and is reported once for the group', async () => {
  const report = await apiReport(fixture(
    [scope('a.one', ['b.two']), scope('b.two', ['c.three']), scope('c.three', ['a.one'])],
    [client('one', ['a.one'])],
    [operation('needs-two', ['b.two'])],
  ))

  const cycles = findingsFor(report, 'scope-implication-cycle')
  assert.equal(cycles.length, 1, 'one finding for the whole group, not one per member')
  assert.equal(cycles[0].evidence, 'cycle: a.one, b.two, c.three')
  assert.equal(cycles[0].location.pointer, '/scopes/0')
  assert.deepEqual(clientRow(report, 'one').effective, ['a.one', 'b.two', 'c.three'])
  assert.equal(report.summary.errors, 0)
})

test('two separate cycles are two separate groups', async () => {
  const report = await apiReport(fixture(
    [
      scope('a.one', ['b.two']), scope('b.two', ['a.one']),
      scope('x.one', ['y.two']), scope('y.two', ['x.one']),
    ],
    [client('one', ['a.one', 'x.one'])],
    [operation('needs-two', ['b.two', 'y.two'])],
  ))

  const cycles = findingsFor(report, 'scope-implication-cycle')
  assert.equal(cycles.length, 2)
  assert.deepEqual(cycles.map((finding) => finding.evidence), ['cycle: a.one, b.two', 'cycle: x.one, y.two'])
})

test('a chain longer than the depth limit stops and says the effective set is a floor', async () => {
  const chain = []
  for (let index = 0; index < 8; index += 1) {
    chain.push(scope(`s${index}`, index === 7 ? undefined : [`s${index + 1}`]))
  }
  const files = fixture(chain, [client('one', ['s0'])], [operation('needs-last', ['s7'])])

  const inside = await apiReport(files, { limits: { maxImplicationDepth: 7 } })
  assert.equal(findingsFor(inside, 'implication-depth-exceeded').length, 0)
  assert.equal(inside.status, 'pass')

  const outside = await apiReport(files, { limits: { maxImplicationDepth: 6 } })
  const finding = findingsFor(outside, 'implication-depth-exceeded')[0]
  assert.equal(finding.location.pointer, '/scopes/0')
  assert.equal(finding.message.includes('maxImplicationDepth limit of 6'), true)
  assert.equal(outside.status, 'incomplete')
  assert.equal(clientRow(outside, 'one').effective.includes('s7'), false, 'the walk really stopped')
})

test('a cycle does not hang the walk even when the depth limit is generous', async () => {
  const report = await apiReport(fixture(
    [scope('a.one', ['b.two']), scope('b.two', ['a.one'])],
    [client('one', ['a.one'])],
    [operation('needs-two', ['b.two'])],
  ), { limits: { maxImplicationDepth: 64 } })

  assert.equal(findingsFor(report, 'implication-depth-exceeded').length, 0)
  assert.deepEqual(clientRow(report, 'one').effective, ['a.one', 'b.two'])
})
