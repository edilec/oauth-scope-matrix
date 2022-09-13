import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  client,
  clientRow,
  findingsFor,
  fixture,
  operation,
  operationRow,
  raisedRules,
  scope,
} from './support.mjs'

test('the least-required set drops a requirement another requirement already implies', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.write', ['catalog.read'])],
    [client('backoffice', ['catalog.write'])],
    [operation('edit-catalog', ['catalog.write', 'catalog.read'])],
  ))

  const row = operationRow(report, 'edit-catalog')
  assert.deepEqual(row.requires, ['catalog.read', 'catalog.write'])
  assert.deepEqual(row.leastRequired, ['catalog.write'])
  assert.equal(row.status, 'covered')

  const finding = findingsFor(report, 'requirement-redundant')[0]
  assert.equal(finding.location.pointer, '/operations/0/requires')
  assert.equal(finding.message.includes('"catalog.read", which "catalog.write" already implies'), true)
})

test('a requirement nothing else implies stays in the least-required set', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('orders.read')],
    [client('backoffice', ['catalog.read', 'orders.read'])],
    [operation('report', ['catalog.read', 'orders.read'])],
  ))

  assert.deepEqual(operationRow(report, 'report').leastRequired, ['catalog.read', 'orders.read'])
  assert.equal(findingsFor(report, 'requirement-redundant').length, 0)
})

test('an operation no client covers is reported with the closest client and what it is missing', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('orders.read'), scope('billing.read')],
    [
      client('reader', ['catalog.read']),
      client('desk', ['catalog.read', 'orders.read']),
    ],
    [
      operation('list-catalog', ['catalog.read']),
      operation('reconcile', ['catalog.read', 'orders.read', 'billing.read']),
    ],
  ))

  const finding = findingsFor(report, 'operation-uncovered')[0]
  assert.equal(finding.location.file, 'operations.json')
  assert.equal(finding.location.pointer, '/operations/1/requires')
  assert.equal(finding.evidence, 'closest client "desk" is missing: billing.read')
  assert.equal(operationRow(report, 'reconcile').status, 'uncovered')
  assert.deepEqual(operationRow(report, 'reconcile').coveredBy, [])
  assert.equal(report.summary.uncovered, 1)
  assert.equal(report.summary.covered, 1)
  assert.equal(report.status, 'fail')
})

test('with no client at all the uncovered finding says so rather than naming one', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [],
    [operation('list-catalog', ['catalog.read'])],
  ))

  assert.deepEqual(raisedRules(report), ['no-clients', 'operation-uncovered'])
  assert.equal(findingsFor(report, 'operation-uncovered')[0].evidence, 'no client declared; required: catalog.read')
  assert.equal(report.status, 'fail', 'an empty client list is evidence, not missing evidence')
})

test('a grant no covered operation needs is reported as spare', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('billing.write')],
    [client('backoffice', ['catalog.read', 'billing.write'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'grant-unused')[0]
  assert.equal(finding.location.file, 'clients.json')
  assert.equal(finding.location.pointer, '/clients/0/scopes/1')
  assert.equal(finding.message.includes('no operation it covers requires'), true)
  assert.deepEqual(clientRow(report, 'backoffice').extra, ['billing.write'])
  assert.equal(report.summary.extraGrants, 1)
  assert.equal(report.summary.errors, 0, 'a spare grant is worth saying and does not fail the run on its own')
})

test('a grant another grant already implies is reported as implied, not as unused', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.write', ['catalog.read'])],
    [client('backoffice', ['catalog.write', 'catalog.read'])],
    [operation('list-catalog', ['catalog.read']), operation('edit-catalog', ['catalog.write'])],
  ))

  const finding = findingsFor(report, 'grant-implied-by-another')[0]
  assert.equal(finding.location.pointer, '/clients/0/scopes/1')
  assert.equal(finding.message.includes('"catalog.read" and also "catalog.write", which already implies it'), true)
  assert.equal(findingsFor(report, 'grant-unused').length, 0, '"remove it, you already have it" is the accurate advice')
  assert.deepEqual(clientRow(report, 'backoffice').extra, ['catalog.read'])
})

test('a scope nothing grants and nothing requires is reported as exported for nothing', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('legacy.read', undefined, 'Retired in 2024.')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'scope-unused')[0]
  assert.equal(finding.location.file, 'scopes.json')
  assert.equal(finding.location.pointer, '/scopes/1')
  assert.equal(finding.severity, 'info')
  assert.equal(finding.evidence, 'scope: Retired in 2024.')
  assert.equal(report.status, 'pass', 'an info alone does not fail the run')
})

test('an operation that requires nothing is covered by every client, and that is said out loud', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read']), client('anonymous', [])],
    [operation('list-catalog', ['catalog.read']), operation('health', [])],
  ))

  const finding = findingsFor(report, 'operation-requires-nothing')[0]
  assert.equal(finding.location.pointer, '/operations/1/requires')
  assert.equal(finding.message.includes('including one that holds nothing'), true)
  assert.deepEqual(operationRow(report, 'health').coveredBy, ['anonymous', 'backoffice'])
  assert.deepEqual(operationRow(report, 'health').leastRequired, [])
  assert.equal(report.summary.covered, 2)
})

test('a requirement naming an unknown scope is not decided either way', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read']), operation('mystery', ['ghost.scope'])],
  ))

  const finding = findingsFor(report, 'requirement-scope-unknown')[0]
  assert.equal(finding.location.pointer, '/operations/1/requires/0')
  assert.equal(finding.message.includes('an unknown scope is never treated as held'), true)
  assert.equal(operationRow(report, 'mystery').status, 'unevaluated')
  assert.equal(operationRow(report, 'mystery').leastRequired, null)
  assert.equal(findingsFor(report, 'operation-uncovered').length, 0, 'uncovered would be a verdict drawn from evidence nobody has')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
})

test('a granted scope the catalog does not declare makes the coverage answer a floor', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read', 'legacy.everything'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'grant-scope-unknown')[0]
  assert.equal(finding.location.pointer, '/clients/0/scopes/1')
  assert.equal(finding.message.includes('not treated as held'), true)
  assert.deepEqual(clientRow(report, 'backoffice').granted, ['catalog.read'], 'the unknown name is not in the effective set')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
})

test('an empty scope catalog is reported rather than treated as a matrix with nothing wrong', async () => {
  const report = await apiReport(fixture([], [client('backoffice', [])], [operation('health', [])]))

  assert.equal(findingsFor(report, 'no-scopes')[0].location.pointer, '/scopes')
  assert.equal(report.summary.scopes, 0)
})

test('the matrix lists what was compared, and counts only what was evaluated', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.write', ['catalog.read'])],
    [client('backoffice', ['catalog.write'])],
    [operation('list-catalog', ['catalog.read']), operation('edit-catalog', ['catalog.write'])],
  ))

  assert.deepEqual(report.matrix.scopes, ['catalog.read', 'catalog.write'])
  assert.deepEqual(report.matrix.operations.map((row) => row.id), ['edit-catalog', 'list-catalog'])
  assert.deepEqual(report.matrix.clients.map((row) => row.id), ['backoffice'])
  assert.deepEqual(clientRow(report, 'backoffice').covers, ['edit-catalog', 'list-catalog'])
  assert.deepEqual(report.summary, {
    checked: 2,
    errors: 0,
    warnings: 0,
    scopes: 2,
    clients: 1,
    operations: 2,
    covered: 2,
    uncovered: 0,
    unevaluated: 0,
    extraGrants: 0,
  })
})
