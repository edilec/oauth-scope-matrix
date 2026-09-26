import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY, byCodeUnit } from '../src/index.mjs'
import { apiReport, clean, client, clientDocument, fixture, operation, scope } from './support.mjs'

/**
 * The three ordering sites that cannot be pinned, proved equivalent instead of
 * left as gaps.
 *
 * `test/ordering.test.mjs` pins twenty-four of this package's twenty-seven
 * ordering sites by emitting a sequence a collator would emit differently. The
 * remaining three order values drawn from alphabets on which code-unit order
 * and English collation agree on every pair -- rule ids over `[a-z0-9-]`, JSON
 * Pointers over `[a-z0-9/]` plus one `V`, and this package's own limit names.
 * Substituting a collator at those three sites is an *equivalent* mutation: the
 * output cannot change, so no test can catch it, and saying so with an
 * enumeration is more honest than either claiming coverage or leaving a gap.
 *
 * Each case below enumerates every ordered pair of the real values and asserts
 * that the two comparisons agree in sign. The pointer case additionally checks
 * that the vocabulary it enumerates still covers everything the tool emits, so
 * that a new pointer shape fails this test rather than quietly widening the
 * alphabet the proof rests on.
 */

const collator = new Intl.Collator('en')

function everyOrderedPairAgrees(values, label) {
  let compared = 0
  for (const left of values) {
    for (const right of values) {
      const mine = Math.sign(byCodeUnit(left, right))
      const collated = Math.sign(collator.compare(left, right))
      assert.equal(mine, collated, `${label}: "${left}" vs "${right}" would move under collation`)
      compared += 1
    }
  }
  return compared
}

test('every ordered pair of real rule ids collates exactly as it compares by code unit', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)

  assert.equal(ruleIds.length > 30, true, 'the catalog must be the real one for this to prove anything')
  for (const ruleId of ruleIds) assert.match(ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/, 'the alphabet this proof rests on')
  assert.equal(everyOrderedPairAgrees(ruleIds, 'rule id'), ruleIds.length ** 2)
})

test('every ordered pair of real limit names collates exactly as it compares by code unit', () => {
  const names = Object.keys(DEFAULT_LIMITS)

  assert.equal(names.length, 8)
  assert.equal(everyOrderedPairAgrees(names, 'limit name'), names.length ** 2)
})

/**
 * The pointer vocabulary, written out as the shapes the tool can emit.
 *
 * Indices are sampled across the digit-length boundaries where a numeric
 * collator would disagree even though a plain one does not -- 9 before 10, 99
 * before 100 -- because those are the pairs a reviewer would worry about.
 */
const POINTER_SHAPES = Object.freeze([
  { name: 'document', build: () => [''] },
  { name: 'schemaVersion', build: () => ['/schemaVersion'] },
  { name: 'list', build: () => ['/scopes', '/clients', '/operations'] },
  { name: 'entry', build: (n) => [`/scopes/${n}`, `/clients/${n}`, `/operations/${n}`] },
  { name: 'entry id', build: (n) => [`/scopes/${n}/id`, `/clients/${n}/id`, `/operations/${n}/id`] },
  { name: 'entry description', build: (n) => [`/scopes/${n}/description`, `/clients/${n}/description`, `/operations/${n}/description`] },
  { name: 'reference list', build: (n) => [`/scopes/${n}/implies`, `/clients/${n}/scopes`, `/operations/${n}/requires`] },
  { name: 'reference', build: (n, m) => [`/scopes/${n}/implies/${m}`, `/clients/${n}/scopes/${m}`, `/operations/${n}/requires/${m}`] },
])

const INDEX_SAMPLE = Object.freeze([0, 1, 2, 9, 10, 11, 99, 100, 101])

function pointerVocabulary() {
  const pointers = new Set()
  for (const shape of POINTER_SHAPES) {
    for (const n of INDEX_SAMPLE) {
      for (const m of INDEX_SAMPLE) for (const pointer of shape.build(n, m)) pointers.add(pointer)
    }
  }
  return [...pointers]
}

const SHAPE_PATTERNS = Object.freeze({
  document: /^$/,
  schemaVersion: /^\/schemaVersion$/,
  list: /^\/(scopes|clients|operations)$/,
  entry: /^\/(scopes|clients|operations)\/\d+$/,
  'entry id': /^\/(scopes|clients|operations)\/\d+\/id$/,
  'entry description': /^\/(scopes|clients|operations)\/\d+\/description$/,
  'reference list': /^\/(scopes\/\d+\/implies|clients\/\d+\/scopes|operations\/\d+\/requires)$/,
  reference: /^\/(scopes\/\d+\/implies|clients\/\d+\/scopes|operations\/\d+\/requires)\/\d+$/,
})

const long = 'd'.repeat(301)

/**
 * Inputs chosen to make the tool emit at least one pointer of every shape.
 *
 * If a later change introduces a shape none of these produce, the completeness
 * assertion below fails -- which is the point. The proof is only as good as the
 * claim that these are all the pointers there are.
 */
const CORPUS = Object.freeze([
  () => apiReport(clean()),
  () => apiReport({ ...clean(), 'clients.json': ['not a document'] }),
  () => apiReport({ ...clean(), 'operations.json': { schemaVersion: '9', operations: [] } }),
  () => apiReport(fixture([], [], [])),
  () => apiReport(fixture([scope('held'), 'not an object'], [client('one', ['held'])], [operation('op', ['held'])])),
  () => apiReport(fixture([scope('held'), scope('held')], [client('one', ['held'])], [operation('op', ['held'])])),
  () => apiReport(fixture([scope('held'), scope('spare', undefined, long)], [client('one', ['held'])], [operation('op', ['held'])])),
  () => apiReport(fixture([scope('held', ['held', 'ghost'])], [client('one', ['held'])], [operation('op', ['held'])])),
  () => apiReport(
    fixture([scope('held', ['a', 'b'])], [client('one', ['held'])], [operation('op', ['held'])]),
    { limits: { maxScopeRefs: 1 } },
  ),
  () => apiReport(fixture([scope('held')], [{ id: 'one' }], [operation('op', ['held'])])),
  () => apiReport(fixture([scope('held')], [client('one', ['held']), client('one', ['held'])], [operation('op', ['held'])])),
  () => apiReport({
    ...clean(),
    'clients.json': clientDocument([{ id: 'one', description: long, scopes: ['catalog.read'] }]),
  }),
  () => apiReport(fixture([scope('held')], [client('one', [])], [operation('op', [])])),
  () => apiReport(fixture([scope('held')], [client('one', ['held', 'ghost'])], [operation('op', ['held'])])),
  () => apiReport(fixture([scope('held')], [client('one', ['held'])], [operation('op', ['held']), 'not an object'])),
  () => apiReport(fixture(
    [scope('held')],
    [client('one', ['held'])],
    [operation('op', ['held'], long), operation('two', ['held'])],
  )),
  () => apiReport(fixture(
    [scope('top', ['low']), scope('low')],
    [client('one', ['low'])],
    [operation('op', ['top', 'low'])],
  )),
  () => apiReport(fixture([scope('held')], [client('one', ['held'])], [operation('op', ['ghost'])])),
  () => apiReport(fixture(
    [scope('held')],
    [client('one', ['held'])],
    [{ id: 'op', requires: { anyOf: ['held'] } }],
  )),
  () => apiReport(
    fixture([scope('s0', ['s1']), scope('s1', ['s2']), scope('s2')], [client('one', ['s0'])], [operation('op', ['s2'])]),
    { limits: { maxImplicationDepth: 1 } },
  ),
])

test('the pointer vocabulary this proof enumerates still covers everything the tool emits', async () => {
  const emitted = new Set()
  for (const build of CORPUS) {
    const report = await build()
    for (const finding of report.findings) emitted.add(finding.location.pointer)
  }

  assert.equal(emitted.size > 20, true, 'the corpus must produce a real spread of pointers')

  const covered = new Set()
  for (const pointer of emitted) {
    const shape = Object.entries(SHAPE_PATTERNS).find(([, pattern]) => pattern.test(pointer))
    assert.notEqual(shape, undefined, `pointer "${pointer}" matches no declared shape`)
    covered.add(shape[0])
  }
  assert.deepEqual([...covered].sort(byCodeUnit), Object.keys(SHAPE_PATTERNS).sort(byCodeUnit), 'every declared shape is really emitted, and no other shape is')
})

test('every ordered pair of real pointers collates exactly as it compares by code unit', () => {
  const pointers = pointerVocabulary()

  assert.equal(pointers.length > 300, true)
  assert.equal(everyOrderedPairAgrees(pointers, 'pointer'), pointers.length ** 2)
})
