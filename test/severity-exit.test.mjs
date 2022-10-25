import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, cliRun, client, fixture, operation, scope, withRoot } from './support.mjs'

/**
 * Severity, pinned by the process exit code.
 *
 * Four of this package's error rules complete the run: nothing about their input
 * is unknown, unsupported or truncated, so the report is a verdict and the
 * binary exits 1. Demote any of them to a warning and the same input exits 0 --
 * a refusal turned into a green build, which is exactly the drift a table
 * cannot defend against. Three declarations can be edited together; an exit code
 * cannot be edited at all.
 *
 * The warning and info rules are pinned the same way from the other side: each
 * of them alone must exit 0, so promoting one to an error is caught here too.
 *
 * Every expectation below is a literal written at the place it is asserted.
 */

test('a matrix with nothing wrong exits 0 with an empty findings list', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('catalog.read'), scope('catalog.write', ['catalog.read'])],
    [client('backoffice', ['catalog.write'])],
    [operation('list-catalog', ['catalog.read']), operation('edit-catalog', ['catalog.write'])],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(report.findings, [])
})

test('an operation no client covers exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held'), scope('need')],
    [client('one', ['held'])],
    [operation('op', ['held']), operation('gap', ['need'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.uncovered, 1)
})

test('a scope listed twice in one list exits 1', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held')],
    [client('one', ['held', 'held'])],
    [operation('op', ['held'])],
  ))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
})

test('a matrix with no client at all exits 1', async () => {
  const { code, report } = await cliReport(fixture([scope('held')], [], [operation('op', ['held'])]))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 2)
})

test('a matrix with an empty scope catalog exits 1', async () => {
  const { code, report } = await cliReport(fixture([], [client('one', [])], [operation('op', [])]))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
})

test('a run whose only findings are warnings exits 0', async () => {
  const cases = [
    fixture([scope('held')], [client('one', [])], [operation('op', [])]),
    fixture([scope('low'), scope('high', ['low'])], [client('one', ['high', 'low'])], [operation('a', ['high']), operation('b', ['low'])]),
    fixture([scope('held'), scope('spare')], [client('one', ['held', 'spare'])], [operation('op', ['held'])]),
    fixture([scope('low'), scope('high', ['low'])], [client('one', ['high'])], [operation('op', ['high', 'low'])]),
    fixture([scope('one', ['two']), scope('two', ['one'])], [client('c', ['one'])], [operation('op', ['two'])]),
    fixture([scope('held', ['held'])], [client('one', ['held'])], [operation('op', ['held'])]),
  ]

  for (const files of cases) {
    const { code, report } = await cliReport(files)
    assert.equal(report.summary.errors, 0, 'this case must raise no error for the exit code to mean anything')
    assert.equal(report.summary.warnings > 0, true, 'and at least one warning, or it proves nothing')
    assert.equal(report.status, 'pass')
    assert.equal(code, 0)
  }
})

test('a run whose only finding is an info exits 0', async () => {
  const { code, report } = await cliReport(fixture(
    [scope('held'), scope('spare')],
    [client('one', ['held'])],
    [operation('op', ['held'])],
  ))

  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.findings.length, 1)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})

test('an incomplete run exits 2 and carries a report that is not a pass', async () => {
  const { code, report, stdout } = await cliReport(fixture(
    [scope('held')],
    [client('one', ['held', 'ghost'])],
    [operation('op', ['held'])],
  ))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  // Not "and it is not a pass" -- the line above already says which status it
  // is, so a second assertion about the same string has no failure mode of its
  // own. What is worth saying here is why this run could not be a pass: the
  // grant nobody can describe stayed out of what the client is recorded as
  // holding, so every coverage answer about it is a floor.
  assert.deepEqual(report.matrix.clients[0].granted, ['held'])
  assert.equal(JSON.parse(stdout).status, 'incomplete', 'stdout is still a report a consumer can parse')
})

test('a configuration error exits 2 with an empty stdout', async () => {
  const missing = await cliRun([])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--root is required'), true)

  const unknown = await withRoot(fixture([scope('held')], [client('one', ['held'])], [operation('op', ['held'])]), (root) =>
    cliRun(['--root', root, '--max-scope', '3']))
  assert.equal(unknown.code, 2)
  assert.equal(unknown.stdout, '')

  const repeated = await withRoot(fixture([scope('held')], [client('one', ['held'])], [operation('op', ['held'])]), (root) =>
    cliRun(['--root', root, '--scopes', 'a.json', '--scopes', 'b.json']))
  assert.equal(repeated.code, 2)
  assert.equal(repeated.stdout, '')
  assert.equal(repeated.stderr.includes('--scopes was given more than once'), true)
})
