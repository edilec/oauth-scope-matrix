import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, byCodeUnit } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The table against the documented catalog, in both directions.
 *
 * This is worth having and it is **not** the severity test. A frozen table and a
 * markdown catalog are two declarations, and one edit that changes both leaves
 * every assertion here satisfied -- a sibling tool had forty of its fifty-two
 * error rules survive exactly that coordinated flip.
 *
 * What this file is for is the other failure: a rule that exists in the code and
 * is undocumented, or documented and never raised. Severity itself is pinned by
 * `test/severity-exit.test.mjs` and `test/severity-word.test.mjs`, which take no
 * expected value from any table, including this one.
 */

const CATALOG_ROW = /^\| `([a-z0-9-]+)` \| `(error|warning|info)` \|/

async function documentedCatalog() {
  const markdown = await readFile(join(projectDirectory, 'docs/scope-matrix-rules.md'), 'utf8')
  const rows = new Map()
  for (const line of markdown.split(String.fromCharCode(10))) {
    const match = CATALOG_ROW.exec(line)
    if (match === null) continue
    assert.equal(rows.has(match[1]), false, `${match[1]} is documented twice`)
    rows.set(match[1], match[2])
  }
  return rows
}

test('every rule in the table is documented with the same severity', async () => {
  const documented = await documentedCatalog()

  for (const ruleId of Object.keys(RULE_SEVERITY).sort(byCodeUnit)) {
    assert.equal(documented.has(ruleId), true, `${ruleId} is in the table and not in docs/scope-matrix-rules.md`)
    assert.equal(documented.get(ruleId), RULE_SEVERITY[ruleId], `${ruleId} is documented with a different severity`)
  }
})

test('every documented rule is in the table', async () => {
  const documented = await documentedCatalog()

  for (const ruleId of [...documented.keys()].sort(byCodeUnit)) {
    assert.equal(Object.hasOwn(RULE_SEVERITY, ruleId), true, `${ruleId} is documented and not in RULE_SEVERITY`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
})

test('the table is frozen and ordered, and every severity is one of the three', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.deepEqual(Object.keys(RULE_SEVERITY), [...Object.keys(RULE_SEVERITY)].sort(byCodeUnit))
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(['error', 'info', 'warning'].includes(severity), true, `${ruleId} has severity ${severity}`)
  }
})

test('a rule id that is not in the table throws rather than defaulting to something harmless', async () => {
  const { createFinding } = await import('../src/index.mjs')

  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', file: 'scopes.json', pointer: '', message: 'x' }),
    /Rule "invented-rule" is not in RULE_SEVERITY/,
  )
})
