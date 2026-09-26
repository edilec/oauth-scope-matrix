import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, auditScopeMatrix, byCodeUnit } from '../src/index.mjs'
import {
  apiReport,
  client,
  clientDocument,
  findingsFor,
  fixture,
  operation,
  operationDocument,
  projectDirectory,
  scope,
  scopeDocument,
  withRoot,
} from './support.mjs'

/**
 * The two optional fields of a finding, pinned in both directions.
 *
 * `createFinding` gates them: a finding carries `suggestion` only when the rule
 * offered one, and `evidence` only when there is evidence to carry. Neither gate
 * was asserted anywhere. Inverting the suggestion gate gave every one of the
 * twenty rules that offer advice the literal string "undefined" in its place,
 * and inverting the evidence gate gave every evidence-less finding an `evidence`
 * of "undefined" as well -- both with the whole suite still green, because a
 * field nothing reads is a field nothing defends.
 *
 * Each case below names one rule, the input that raises it, and what the two
 * fields must be. `null` means the key must be *absent*, not empty: a consumer
 * that branches on `"suggestion" in finding` must see the same thing the report
 * contract promises. Every expectation is a literal written here; the only other
 * copy is the one at the emitting site in `src/`.
 */

const held = () => [scope('held')]
const one = () => [client('one', ['held'])]
const op = () => [operation('op', ['held'])]
const matrix = () => fixture(held(), one(), op())

const CASES = [
  {
    rule: 'client-duplicate',
    build: () => apiReport(fixture(held(), [client('one', ['held']), client('one', ['held'])], op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'client-grants-nothing',
    build: () => apiReport(fixture(held(), [client('one', [])], [operation('op', [])])),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'client-invalid',
    build: () => apiReport(fixture(held(), [{ id: 'one' }], op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'document-invalid',
    build: () => apiReport({ ...matrix(), 'clients.json': ['not a document'] }),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'grant-implied-by-another',
    build: () => apiReport(fixture(
      [scope('low'), scope('high', ['low'])],
      [client('one', ['high', 'low'])],
      [operation('op', ['high']), operation('two', ['low'])],
    )),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'grant-scope-unknown',
    build: () => apiReport(fixture(held(), [client('one', ['held', 'ghost'])], op())),
    suggestion: 'Export the scope definition, or revoke a grant nobody can describe.',
    evidence: null,
  },
  {
    rule: 'grant-unused',
    build: () => apiReport(fixture([scope('held'), scope('spare')], [client('one', ['held', 'spare'])], op())),
    suggestion: 'Confirm the grant is needed by something outside this matrix, or revoke it.',
    evidence: null,
  },
  {
    rule: 'identifier-invalid',
    build: () => apiReport(fixture([scope('held'), { id: 42 }], one(), op())),
    suggestion: 'An id is 1-120 characters from [A-Za-z0-9._:/+_-], starting with a letter or digit.',
    evidence: null,
  },
  {
    rule: 'identifier-invalid',
    label: 'on a reference rather than an id',
    build: () => apiReport(fixture(held(), [client('one', ['held', 42])], op())),
    suggestion: 'A scope name is 1-120 characters from [A-Za-z0-9._:/+_-], starting with a letter or digit.',
    evidence: null,
  },
  {
    rule: 'implication-depth-exceeded',
    build: () => apiReport(
      fixture([scope('s0', ['s1']), scope('s1', ['s2']), scope('s2')], [client('one', ['s0'])], [operation('op', ['s2'])]),
      { limits: { maxImplicationDepth: 1 } },
    ),
    suggestion: 'Raise --max-implication-depth, or flatten the implication chain.',
    evidence: null,
  },
  {
    rule: 'input-not-json',
    build: () => apiReport({ ...matrix(), 'scopes.json': '{ "schemaVersion": "1",' }),
    suggestion: 'Validate the file with a JSON parser before re-running.',
    evidence: null,
  },
  {
    rule: 'input-not-utf8',
    build: () => apiReport({ ...matrix(), 'scopes.json': new Uint8Array([0x7b, 0xff, 0x7d]) }),
    suggestion: 'Re-encode the file as UTF-8.',
    evidence: null,
  },
  {
    rule: 'input-too-large',
    build: () => apiReport(
      { ...matrix(), 'scopes.json': scopeDocument([scope('held', undefined, 'd'.repeat(300))]) },
      { limits: { maxFileBytes: 100 } },
    ),
    suggestion: 'Raise --max-file-bytes, or split the input.',
    evidence: null,
  },
  {
    rule: 'input-unreadable',
    build: () => apiReport({ 'clients.json': clientDocument(one()), 'operations.json': operationDocument(op()) }),
    suggestion: 'Check the file name and its permissions.',
    evidence: null,
  },
  {
    rule: 'no-clients',
    build: () => apiReport(fixture(held(), [], op())),
    suggestion: 'Export at least one client grant.',
    evidence: null,
  },
  {
    rule: 'no-operations-evaluated',
    build: () => apiReport(fixture(held(), one(), [])),
    suggestion: 'Declare the operations this matrix is meant to cover, and fix whatever stopped the ones that are there from being evaluated.',
    evidence: null,
  },
  {
    rule: 'no-scopes',
    build: () => apiReport(fixture([], [client('one', [])], [operation('op', [])])),
    suggestion: 'Export the provider scope definitions before comparing anything against them.',
    evidence: null,
  },
  {
    rule: 'operation-duplicate',
    build: () => apiReport(fixture(held(), one(), [operation('op', ['held']), operation('op', ['held'])])),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'operation-invalid',
    build: () => apiReport(fixture(held(), one(), [operation('op', ['held']), 'not an object'])),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'operation-requires-nothing',
    build: () => apiReport(fixture(held(), one(), [operation('op', ['held']), operation('open', [])])),
    suggestion: 'Confirm the operation is meant to be reachable without any scope.',
    evidence: null,
  },
  {
    rule: 'operation-uncovered',
    build: () => apiReport(fixture(
      [scope('held'), scope('need')],
      one(),
      [operation('op', ['held']), operation('gap', ['need'])],
    )),
    suggestion: 'Grant the missing scopes to a client, or retire the operation.',
    evidence: 'closest client "one" is missing: need',
  },
  {
    rule: 'path-escapes-root',
    build: () => withRoot(
      { 'clients.json': clientDocument(one()), 'operations.json': operationDocument(op()) },
      async (root) => {
        await symlink(join(projectDirectory, 'examples/clean/scopes.json'), join(root, 'scopes.json'))
        return auditScopeMatrix({ root })
      },
    ),
    suggestion: 'Keep all three documents inside the declared root; a symbolic link out of the tree is refused.',
    evidence: null,
  },
  {
    rule: 'requirement-redundant',
    build: () => apiReport(fixture(
      [scope('low'), scope('high', ['low'])],
      [client('one', ['high'])],
      [operation('op', ['high', 'low'])],
    )),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'requirement-scope-unknown',
    build: () => apiReport(fixture(held(), one(), [operation('op', ['held']), operation('mystery', ['ghost'])])),
    suggestion: 'Export the scope definition, or correct the requirement.',
    evidence: null,
  },
  {
    rule: 'requirement-unsupported',
    build: () => apiReport(fixture(held(), one(), [operation('op', ['held']), { id: 'either', requires: { anyOf: ['held'] } }])),
    suggestion: 'Express "requires" as a flat array of scope names that must all be held, or evaluate this operation by hand.',
    evidence: null,
  },
  {
    rule: 'schema-version-unsupported',
    build: () => apiReport({ ...matrix(), 'scopes.json': { schemaVersion: '2', scopes: held() } }),
    suggestion: 'Re-export the document as schemaVersion "1".',
    evidence: null,
  },
  {
    rule: 'scope-duplicate',
    build: () => apiReport(fixture([scope('held'), scope('held')], one(), op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'scope-implication-cycle',
    build: () => apiReport(fixture(
      [scope('one', ['two']), scope('two', ['one'])],
      [client('c', ['one'])],
      [operation('op', ['two'])],
    )),
    suggestion: 'Break the loop so that one scope is the broader one.',
    evidence: 'cycle: one, two',
  },
  {
    rule: 'scope-implication-self',
    build: () => apiReport(fixture([scope('held', ['held'])], one(), op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'scope-implication-unknown',
    build: () => apiReport(fixture([scope('held', ['ghost'])], one(), op())),
    suggestion: 'Declare the implied scope, or remove the implication.',
    evidence: null,
  },
  {
    rule: 'scope-invalid',
    build: () => apiReport(fixture([scope('held'), 'not an object'], one(), op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'scope-pattern-unsupported',
    build: () => apiReport(fixture([scope('held'), scope('catalog.*')], one(), op())),
    suggestion: 'Declare each concrete scope name the pattern stands for.',
    evidence: null,
  },
  {
    rule: 'scope-pattern-unsupported',
    label: 'on a reference rather than a declaration',
    build: () => apiReport(fixture(held(), [client('one', ['held', 'catalog.*'])], op())),
    suggestion: 'List the scope names the pattern was meant to stand for.',
    evidence: null,
  },
  {
    rule: 'scope-reference-duplicate',
    build: () => apiReport(fixture(held(), [client('one', ['held', 'held'])], op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'scope-unused',
    build: () => apiReport(fixture([scope('held'), scope('spare')], one(), op())),
    suggestion: null,
    evidence: null,
  },
  {
    rule: 'time-budget-exceeded',
    build: () => {
      let ticks = 0
      return apiReport(matrix(), { clock: () => (ticks++ === 0 ? 0 : 5000), limits: { maxRuntimeMs: 1 } })
    },
    suggestion: 'Raise --max-runtime-ms, or split the documents.',
    evidence: null,
  },
  {
    rule: 'too-many-clients',
    build: () => apiReport(
      fixture(held(), [client('one', ['held']), client('two', ['held'])], op()),
      { limits: { maxClients: 1 } },
    ),
    suggestion: 'Raise --max-clients, or split the document.',
    evidence: null,
  },
  {
    rule: 'too-many-findings',
    build: () => apiReport(
      fixture([scope('a1'), scope('a2'), scope('a3')], [client('one', [])], [operation('op', [])]),
      { limits: { maxFindings: 2 } },
    ),
    suggestion: 'Raise --max-findings, or narrow the inputs.',
    evidence: null,
  },
  {
    rule: 'too-many-operations',
    build: () => apiReport(
      fixture(held(), one(), [operation('op', ['held']), operation('two', ['held'])]),
      { limits: { maxOperations: 1 } },
    ),
    suggestion: 'Raise --max-operations, or split the document.',
    evidence: null,
  },
  {
    rule: 'too-many-scope-references',
    build: () => apiReport(
      fixture([scope('held'), scope('other')], [client('one', ['held', 'other'])], op()),
      { limits: { maxScopeRefs: 1 } },
    ),
    suggestion: 'Raise --max-scope-refs, or split the entry.',
    evidence: null,
  },
  {
    rule: 'too-many-scopes',
    build: () => apiReport(fixture([scope('held'), scope('other')], one(), op()), { limits: { maxScopes: 1 } }),
    suggestion: 'Raise --max-scopes, or split the document.',
    evidence: null,
  },
]

for (const { rule, label, build, suggestion, evidence } of CASES) {
  test(`${rule} carries the suggestion and the evidence its contract promises${label === undefined ? '' : `, ${label}`}`, async () => {
    const report = await build()
    const finding = findingsFor(report, rule)[0]
    assert.notEqual(finding, undefined, `this input must raise ${rule} for the case to mean anything`)

    if (suggestion === null) {
      assert.equal(Object.hasOwn(finding, 'suggestion'), false, `${rule} offers no advice, so it carries no suggestion key at all`)
    } else {
      assert.equal(finding.suggestion, suggestion)
    }

    if (evidence === null) {
      assert.equal(Object.hasOwn(finding, 'evidence'), false, `${rule} has no evidence here, so it carries no evidence key at all`)
    } else {
      assert.equal(finding.evidence, evidence)
    }
  })
}

test('every rule in the catalog declares its suggestion and evidence contract above', () => {
  const covered = new Set(CASES.map((testCase) => testCase.rule))

  for (const ruleId of Object.keys(RULE_SEVERITY).sort(byCodeUnit)) {
    assert.equal(covered.has(ruleId), true, `${ruleId} raises a finding nothing here pins the optional fields of`)
  }
  assert.equal(covered.size, Object.keys(RULE_SEVERITY).length)
})

test('a suggestion is bounded and flattened like every other untrusted string', async () => {
  const report = await apiReport(fixture(
    [scope('held')],
    [client('one', ['held'])],
    [operation('op', ['held']), { id: 'either', requires: { anyOf: ['held'] } }],
  ))
  const finding = findingsFor(report, 'requirement-unsupported')[0]

  assert.equal(finding.suggestion.length <= 300, true)
  assert.equal(finding.suggestion.includes(String.fromCharCode(10)), false)
})
