import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  client,
  clientDocument,
  findingsFor,
  fixture,
  operation,
  operationDocument,
  raisedRules,
  scope,
  scopeDocument,
} from './support.mjs'

test('the reference matrix raises nothing at all, so every case below is the one thing it broke', async () => {
  const report = await apiReport(clean())

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
})

test('a document that is not an object is refused whole', async () => {
  const files = clean()
  files['clients.json'] = ['not', 'a', 'document']
  const report = await apiReport(files)

  const finding = findingsFor(report, 'document-invalid')[0]
  assert.equal(finding.location.file, 'clients.json')
  assert.equal(finding.location.pointer, '')
  assert.equal(finding.message.includes('an array of 3 item(s)'), true)
  assert.equal(report.status, 'incomplete')
})

test('an unknown top-level key is refused rather than ignored, so a typo cannot disable a check', async () => {
  const files = clean()
  files['operations.json'] = { schemaVersion: '1', operation: [], operations: [] }
  const report = await apiReport(files)

  const finding = findingsFor(report, 'document-invalid')[0]
  assert.equal(finding.message.includes('"operation"'), true)
  assert.equal(report.status, 'incomplete')
})

test('a field that would carry a credential is an unknown key, so no token can reach this tool by accident', async () => {
  const files = clean()
  files['clients.json'] = clientDocument([
    { id: 'backoffice', scopes: ['catalog.write'], accessToken: 'ya29.NOT-A-REAL-TOKEN' },
  ])
  const report = await apiReport(files)

  const finding = findingsFor(report, 'client-invalid')[0]
  assert.equal(finding.message.includes('"accessToken"'), true)
  assert.equal(JSON.stringify(report).includes('ya29'), false, 'and the value is named nowhere in the report')
})

test('an unsupported schemaVersion is named as unsupported and never guessed at', async () => {
  const files = clean()
  files['scopes.json'] = { schemaVersion: '2', scopes: [scope('catalog.read')] }
  const report = await apiReport(files)

  const finding = findingsFor(report, 'schema-version-unsupported')[0]
  assert.equal(finding.location.pointer, '/schemaVersion')
  assert.equal(finding.message.includes('a string of 1 character(s)'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.scopes, 0, 'nothing was compiled from it')
})

test('a missing schemaVersion is unsupported too, rather than defaulted', async () => {
  const files = clean()
  files['scopes.json'] = { scopes: [scope('catalog.read')] }
  const report = await apiReport(files)

  assert.equal(findingsFor(report, 'schema-version-unsupported').length, 1)
  assert.equal(findingsFor(report, 'schema-version-unsupported')[0].message.includes('nothing'), true)
})

test('an entry that is not an object is refused, and the rest of the document still compiles', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), 'catalog.write'],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'scope-invalid')[0]
  assert.equal(finding.location.pointer, '/scopes/1')
  assert.equal(report.summary.scopes, 1)
  assert.equal(report.status, 'incomplete', 'part of the document was refused, so the run is not a verdict on all of it')
})

test('an entry with an unusable id is refused without the id being echoed back', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), { id: { nested: true } }],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'identifier-invalid')[0]
  assert.equal(finding.location.pointer, '/scopes/1/id')
  assert.equal(finding.message.includes('an object'), true)
  assert.equal(JSON.stringify(report).includes('nested'), false)
})

test('a duplicate id is refused because neither copy is authoritative', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.read', ['catalog.read'])],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'scope-duplicate')[0]
  assert.equal(finding.location.pointer, '/scopes/1/id')
  assert.equal(finding.message.includes('/scopes/0'), true, 'the first copy is named')
  assert.equal(report.summary.scopes, 1)
})

test('a duplicate client id and a duplicate operation id are refused the same way', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read']), client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read']), operation('list-catalog', ['catalog.read'])],
  ))

  assert.equal(findingsFor(report, 'client-duplicate').length, 1)
  assert.equal(findingsFor(report, 'operation-duplicate').length, 1)
  assert.equal(report.summary.clients, 1)
  assert.equal(report.summary.operations, 1)
})

test('a client with no "scopes" list is refused; an empty list is a statement and is read as one', async () => {
  const missing = await apiReport(fixture(
    [scope('catalog.read')],
    [{ id: 'backoffice' }],
    [operation('list-catalog', ['catalog.read'])],
  ))
  assert.equal(findingsFor(missing, 'client-invalid')[0].message.includes('declares no "scopes" list'), true)

  const empty = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', [])],
    [operation('list-catalog', ['catalog.read'])],
  ))
  assert.equal(findingsFor(empty, 'client-grants-nothing').length, 1)
  assert.equal(findingsFor(empty, 'client-invalid').length, 0)
})

test('a scope with no "implies" list implies nothing, and that is not a defect', async () => {
  const report = await apiReport(clean())

  assert.equal(raisedRules(report).length, 0)
  assert.deepEqual(report.matrix.clients[0].effective, ['catalog.read', 'catalog.write'])
})

test('an alternative-requirement construct is named as unsupported, not as malformed', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.write')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read']), { id: 'either', requires: { anyOf: ['catalog.read', 'catalog.write'] } }],
  ))

  const finding = findingsFor(report, 'requirement-unsupported')[0]
  assert.equal(finding.location.pointer, '/operations/1/requires')
  assert.equal(finding.message.includes('anyOf'), true)
  assert.equal(finding.message.includes('not evaluated rather than assumed satisfied'), true)
  assert.equal(findingsFor(report, 'operation-invalid').length, 0, 'the operation is well formed; this build is the limited party')
  assert.equal(report.status, 'incomplete')
})

test('a requires that is neither an array nor a recognised construct is simply malformed', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read'])],
    [{ id: 'list-catalog', requires: 'catalog.read' }],
  ))

  const finding = findingsFor(report, 'operation-invalid')[0]
  assert.equal(finding.message.includes('must be an array of scope names'), true)
  assert.equal(findingsFor(report, 'requirement-unsupported').length, 0)
})

test('a pattern is refused wherever it appears, and expanded nowhere', async () => {
  const asDefinition = await apiReport(fixture(
    [scope('catalog.read'), scope('catalog.*')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))
  assert.equal(findingsFor(asDefinition, 'scope-pattern-unsupported')[0].location.pointer, '/scopes/1/id')

  const asGrant = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.*'])],
    [operation('list-catalog', ['catalog.read'])],
  ))
  const finding = findingsFor(asGrant, 'scope-pattern-unsupported')[0]
  assert.equal(finding.location.pointer, '/clients/0/scopes/0')
  assert.equal(asGrant.matrix.clients[0].effective.length, 0, 'the pattern conferred nothing')
  assert.equal(findingsFor(asGrant, 'operation-uncovered').length, 1, 'so the operation is not covered by it')
  assert.equal(asGrant.status, 'incomplete', 'and the run is not a verdict')
})

test('a repeated reference is counted once and reported once', async () => {
  const report = await apiReport(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read', 'catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))

  const finding = findingsFor(report, 'scope-reference-duplicate')[0]
  assert.equal(finding.location.pointer, '/clients/0/scopes/1')
  assert.deepEqual(report.matrix.clients[0].granted, ['catalog.read'])
  assert.equal(report.status, 'fail', 'nothing is unknown here, so this is a verdict and not missing evidence')
})

test('a description is bounded on both sides of the documented limit', async () => {
  const inside = await apiReport(fixture(
    [scope('catalog.read', undefined, 'd'.repeat(300))],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))
  assert.equal(inside.summary.scopes, 1)

  const outside = await apiReport(fixture(
    [scope('catalog.read', undefined, 'd'.repeat(301))],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ))
  assert.equal(findingsFor(outside, 'scope-invalid')[0].location.pointer, '/scopes/0/description')
  assert.equal(outside.summary.scopes, 0)
})

test('each document is decoded strictly, the scope catalog included', async () => {
  for (const name of ['clients.json', 'operations.json', 'scopes.json']) {
    const files = clean()
    files[name] = new Uint8Array([0x7b, 0xff, 0x7d])
    const report = await apiReport(files)

    const finding = findingsFor(report, 'input-not-utf8')[0]
    assert.equal(finding.location.file, name)
    assert.equal(report.status, 'incomplete')
  }
})

test('a document that is not JSON says so without quoting the file back', async () => {
  const files = clean()
  files['scopes.json'] = '{ "schemaVersion": "1", '
  const report = await apiReport(files)

  assert.equal(findingsFor(report, 'input-not-json')[0].location.file, 'scopes.json')
  assert.equal(report.status, 'incomplete')
})

test('the three documents are named by the caller and each name is validated', async () => {
  const files = {
    'a.json': scopeDocument([scope('catalog.read')]),
    'b.json': clientDocument([client('backoffice', ['catalog.read'])]),
    'c.json': operationDocument([operation('list-catalog', ['catalog.read'])]),
  }
  const report = await apiReport(files, { scopes: 'a.json', clients: 'b.json', operations: 'c.json' })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')

  await assert.rejects(
    () => apiReport(files, { scopes: '/etc/passwd' }),
    /--scopes must be relative to --root/,
  )
  await assert.rejects(
    () => apiReport(files, { clients: '../outside.json' }),
    /--clients must not step outside --root/,
  )
})

test('an unknown option throws instead of being ignored', async () => {
  await assert.rejects(() => apiReport(clean(), { scope: 'scopes.json' }), /Unknown option "scope"/)
  await assert.rejects(() => apiReport(clean(), { clock: 'noon' }), /clock must be a function/)
})
