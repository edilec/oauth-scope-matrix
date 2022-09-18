import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, validateLimits } from '../src/index.mjs'
import { apiReport, clean, client, findingsFor, fixture, operation, scope } from './support.mjs'

/**
 * Every documented limit, enforced and tested from both sides of the bound.
 *
 * A limit that is documented and never wired is the same defect as a limit that
 * is ignored: a sibling tool in this catalog accepted a configuration key and
 * silently did nothing with it. Each case below therefore runs the input that
 * sits exactly on the bound as well as the one past it.
 */

test('an unknown limit key throws rather than being ignored', async () => {
  assert.throws(() => validateLimits({ maxScope: 10 }), /Unknown limit "maxScope"/)
  assert.throws(() => validateLimits({ maxScope: 10 }), /known limits are maxClients, maxFileBytes/)
  await assert.rejects(() => apiReport(clean(), { limits: { maxscopes: 10 } }), /Unknown limit "maxscopes"/)
})

test('a limit override is an integer inside the hard cap', () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    assert.deepEqual(validateLimits({ [key]: 1 })[key], 1)
    assert.deepEqual(validateLimits({ [key]: HARD_LIMITS[key] })[key], HARD_LIMITS[key])
    assert.throws(() => validateLimits({ [key]: 0 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: HARD_LIMITS[key] + 1 }), new RegExp(`limits.${key} must be an integer`))
    assert.throws(() => validateLimits({ [key]: 1.5 }), new RegExp(`limits.${key} must be an integer`))
  }
  assert.throws(() => validateLimits([]), /limits must be an object/)
})

test('maxScopes is enforced from both sides, and nothing is compiled from a document past it', async () => {
  const scopes = [scope('a.one'), scope('b.two')]
  const files = fixture(scopes, [client('one', ['a.one', 'b.two'])], [operation('needs', ['a.one', 'b.two'])])

  const inside = await apiReport(files, { limits: { maxScopes: 2 } })
  assert.equal(findingsFor(inside, 'too-many-scopes').length, 0)
  assert.equal(inside.summary.scopes, 2)

  const outside = await apiReport(files, { limits: { maxScopes: 1 } })
  const finding = findingsFor(outside, 'too-many-scopes')[0]
  assert.equal(finding.location.pointer, '/scopes')
  assert.equal(finding.message.includes('maxScopes limit of 1'), true)
  assert.equal(outside.summary.scopes, 0, 'a prefix was not read and reported as the whole')
  assert.equal(outside.status, 'incomplete')
})

test('maxClients and maxOperations are enforced the same way', async () => {
  const files = fixture(
    [scope('a.one')],
    [client('one', ['a.one']), client('two', ['a.one'])],
    [operation('x', ['a.one']), operation('y', ['a.one'])],
  )

  const clients = await apiReport(files, { limits: { maxClients: 1 } })
  assert.equal(findingsFor(clients, 'too-many-clients')[0].location.file, 'clients.json')
  assert.equal(clients.summary.clients, 0)

  const operations = await apiReport(files, { limits: { maxOperations: 1 } })
  assert.equal(findingsFor(operations, 'too-many-operations')[0].location.file, 'operations.json')
  assert.equal(operations.summary.operations, 0)

  const inside = await apiReport(files, { limits: { maxClients: 2, maxOperations: 2 } })
  assert.equal(inside.status, 'pass')
})

test('maxScopeRefs refuses the entry rather than reading part of its list', async () => {
  const files = fixture(
    [scope('a.one'), scope('b.two')],
    [client('one', ['a.one', 'b.two'])],
    [operation('needs', ['a.one', 'b.two'])],
  )

  const inside = await apiReport(files, { limits: { maxScopeRefs: 2 } })
  assert.equal(findingsFor(inside, 'too-many-scope-references').length, 0)

  const outside = await apiReport(files, { limits: { maxScopeRefs: 1 } })
  const finding = findingsFor(outside, 'too-many-scope-references')[0]
  assert.equal(finding.message.includes('maxScopeRefs limit of 1'), true)
  assert.equal(outside.summary.clients, 0, 'the client was refused, not granted a shorter list than it declares')
  assert.equal(outside.status, 'incomplete')
})

test('maxFileBytes is enforced from both sides and the file is not read past it', async () => {
  const files = clean()
  const sizes = Object.entries(files)
    .map(([name, document]) => [name, Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`)])
    .sort((left, right) => right[1] - left[1])
  const [largestName, bytes] = sizes[0]

  const inside = await apiReport(files, { limits: { maxFileBytes: bytes } })
  assert.equal(findingsFor(inside, 'input-too-large').length, 0)
  assert.equal(inside.status, 'pass')

  const outside = await apiReport(files, { limits: { maxFileBytes: bytes - 1 } })
  const finding = findingsFor(outside, 'input-too-large')[0]
  assert.equal(finding.location.file, largestName)
  assert.equal(finding.message.includes('it was not read'), true)
  assert.equal(outside.status, 'incomplete')
})

test('maxFindings truncates with a finding that names the limit, never silently', async () => {
  const scopes = []
  for (let index = 0; index < 6; index += 1) scopes.push(scope(`s${index}`))
  const files = fixture(scopes, [client('one', [])], [operation('needs', ['s0'])])

  const inside = await apiReport(files, { limits: { maxFindings: 8 } })
  assert.equal(findingsFor(inside, 'too-many-findings').length, 0)
  const total = inside.findings.length
  assert.equal(total > 3, true, 'this fixture must raise several findings for the case to mean anything')

  const outside = await apiReport(files, { limits: { maxFindings: 3 } })
  assert.equal(outside.findings.length, 3)
  const finding = findingsFor(outside, 'too-many-findings')[0]
  assert.equal(finding.message.includes(`${total - 2} were not reported`), true)
  assert.equal(outside.status, 'incomplete')
})

test('the time budget is enforced through an injected clock, and the run says it stopped early', async () => {
  let ticks = 0
  const runaway = () => (ticks++ === 0 ? 0 : 5000)

  const report = await apiReport(clean(), { clock: runaway, limits: { maxRuntimeMs: 1 } })
  const finding = findingsFor(report, 'time-budget-exceeded')[0]
  assert.equal(finding.message.includes('maxRuntimeMs budget of 1'), true)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')

  const frozen = await apiReport(clean(), { clock: () => 0, limits: { maxRuntimeMs: 1 } })
  assert.equal(findingsFor(frozen, 'time-budget-exceeded').length, 0)
  assert.equal(frozen.status, 'pass')
})

test('the default clock is a real monotonic source, so the budget is enforced without an injection', async () => {
  // Enough work that a millisecond is certainly gone by the first checkpoint,
  // and not so much that the generous run is slow. Asserting both directions is
  // what shows the default clock advances: a constant would trip neither, and a
  // budget that is never consulted would trip neither either.
  const scopeList = []
  const grants = []
  for (let index = 0; index < 120; index += 1) {
    scopeList.push(scope(`s${index}`))
    grants.push(`s${index}`)
  }
  const clientList = []
  for (let index = 0; index < 60; index += 1) clientList.push(client(`c${index}`, grants))
  const operationList = []
  for (let index = 0; index < 200; index += 1) operationList.push(operation(`o${index}`, grants))
  const files = fixture(scopeList, clientList, operationList)

  const tight = await apiReport(files, { limits: { maxRuntimeMs: 1, maxScopeRefs: 200 } })
  assert.equal(findingsFor(tight, 'time-budget-exceeded').length, 1)
  assert.equal(tight.status, 'incomplete')

  const generous = await apiReport(files, { limits: { maxRuntimeMs: 600000, maxScopeRefs: 200 } })
  assert.equal(findingsFor(generous, 'time-budget-exceeded').length, 0)
  assert.equal(generous.status, 'pass')
})
