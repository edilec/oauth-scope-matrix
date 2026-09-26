import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by what the tool actually emits, for every rule in the
 * catalog.
 *
 * This file deliberately shares nothing with the rest of the suite. It imports
 * no severity table, reads no documented catalog, and takes no expectation from
 * a map, a fixture module or a loop variable: every rule id, every count and
 * every printed line is written out inline, at the place it is asserted.
 *
 * That is the whole point. A frozen table, a markdown catalog and a test's
 * expected-value map are three declarations, and one edit that changes all
 * three leaves every assertion that compares them satisfied -- including an
 * assertion made inside a loop over that same map. Nothing below can be
 * satisfied by editing a declaration. `assert.equal(report.summary.errors, 1)`
 * is false the moment a rule stops being an error, and
 * `stderr.includes('ERROR   ...')` is false the moment it stops being printed
 * as one.
 *
 * Twenty-seven of the error rules also mark the run incomplete, so they exit 2
 * whether their severity says `error` or `warning`; for those the exit code is
 * not the discriminator and the error count and the printed word are.
 * `test/severity-exit.test.mjs` covers the four that complete the run, where the
 * exit code flips from 1 to 0 on a demotion.
 *
 * The builders below are inputs. They carry no severity, no rule id and no
 * count.
 */

const execFileAsync = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/oauth-scope-matrix.mjs')

const scopes = (list) => ({ schemaVersion: '1', scopes: list })
const clients = (list) => ({ schemaVersion: '1', clients: list })
const operations = (list) => ({ schemaVersion: '1', operations: list })

/** Build a root, run the real binary over it with the human report on, tear the root down. */
async function audit(files, extraArgs = [], plant) {
  const root = await mkdtemp(join(tmpdir(), 'oauth-scope-matrix-word-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array ? content : JSON.stringify(content)
      await writeFile(join(root, name), bytes)
    }
    if (plant !== undefined) await plant(root)
    return await spawn(['--root', root, ...extraArgs])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function spawn(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr ?? '' }
  }
}

const HELD = { schemaVersion: '1', scopes: [{ id: 'held' }] }
const ONE = { schemaVersion: '1', clients: [{ id: 'one', scopes: ['held'] }] }
const OP = { schemaVersion: '1', operations: [{ id: 'op', requires: ['held'] }] }

test('client-duplicate prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: ['held'] }, { id: 'one', scopes: ['held'] }]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json/clients/1/id client-duplicate'), true)
})

test('client-grants-nothing prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: [] }]),
    'operations.json': operations([{ id: 'op', requires: [] }]),
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING clients.json/clients/0/scopes client-grants-nothing'), true)
})

test('client-invalid prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: ['held'] }, { id: 'two' }]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json/clients/1 client-invalid'), true)
})

test('document-invalid prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ['not a document'],
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json document-invalid'), true)
})

test('grant-implied-by-another prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'low' }, { id: 'high', implies: ['low'] }]),
    'clients.json': clients([{ id: 'one', scopes: ['high', 'low'] }]),
    'operations.json': operations([{ id: 'op', requires: ['high'] }, { id: 'two', requires: ['low'] }]),
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING clients.json/clients/0/scopes/1 grant-implied-by-another'), true)
})

test('grant-scope-unknown prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: ['held', 'ghost'] }]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json/clients/0/scopes/1 grant-scope-unknown'), true)
})

test('grant-unused prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'spare' }]),
    'clients.json': clients([{ id: 'one', scopes: ['held', 'spare'] }]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING clients.json/clients/0/scopes/1 grant-unused'), true)
})

test('identifier-invalid prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 42 }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/1/id identifier-invalid'), true)
})

test('implication-depth-exceeded prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 's0', implies: ['s1'] }, { id: 's1', implies: ['s2'] }, { id: 's2' }]),
    'clients.json': clients([{ id: 'one', scopes: ['s0'] }, { id: 'deep', scopes: ['s2'] }]),
    'operations.json': operations([{ id: 'op', requires: ['s1'] }, { id: 'two', requires: ['s2'] }]),
  }, ['--max-implication-depth', '1'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/0 implication-depth-exceeded'), true)
})

test('input-not-json prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': '{ "schemaVersion": "1",',
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json input-not-json'), true)
})

test('input-not-utf8 prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': new Uint8Array([0x7b, 0xff, 0x7d]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json input-not-utf8'), true)
})

test('input-too-large prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held', description: 'd'.repeat(300) }]),
    'clients.json': ONE,
    'operations.json': OP,
  }, ['--max-file-bytes', '100'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json input-too-large'), true)
})

test('input-unreadable prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json input-unreadable'), true)
})

test('no-clients prints ERROR and is counted alongside the operation nobody covers', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 2)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(stderr.includes('ERROR   clients.json/clients no-clients'), true)
  assert.equal(stderr.includes('ERROR   operations.json/operations/0/requires operation-uncovered'), true)
})

test('no-operations-evaluated prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations no-operations-evaluated'), true)
})

test('no-scopes prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([]),
    'clients.json': clients([{ id: 'one', scopes: [] }]),
    'operations.json': operations([{ id: 'op', requires: [] }]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes no-scopes'), true)
})

test('operation-duplicate prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'op', requires: ['held'] }]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations/1/id operation-duplicate'), true)
})

test('operation-invalid prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, 'not an object']),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations/1 operation-invalid'), true)
})

test('operation-requires-nothing prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'open', requires: [] }]),
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING operations.json/operations/1/requires operation-requires-nothing'), true)
})

test('operation-uncovered prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'need' }]),
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'gap', requires: ['need'] }]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(stderr.includes('ERROR   operations.json/operations/1/requires operation-uncovered'), true)
})

test('path-escapes-root prints ERROR and counts one error', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'oauth-scope-matrix-outside-'))
  try {
    await writeFile(join(outside, 'planted.json'), JSON.stringify(HELD))
    const { code, report, stderr } = await audit({
      'clients.json': ONE,
      'operations.json': OP,
    }, [], (root) => symlink(join(outside, 'planted.json'), join(root, 'scopes.json')))

    assert.equal(report.summary.errors, 1)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.equal(stderr.includes('ERROR   scopes.json path-escapes-root'), true)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('requirement-redundant prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'low' }, { id: 'high', implies: ['low'] }]),
    'clients.json': clients([{ id: 'one', scopes: ['high'] }]),
    'operations.json': operations([{ id: 'op', requires: ['high', 'low'] }]),
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING operations.json/operations/0/requires requirement-redundant'), true)
})

test('requirement-scope-unknown prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'mystery', requires: ['ghost'] }]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations/1/requires/0 requirement-scope-unknown'), true)
})

test('requirement-unsupported prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'either', requires: { anyOf: ['held'] } }]),
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations/1/requires requirement-unsupported'), true)
})

test('schema-version-unsupported prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': { schemaVersion: '2', scopes: [{ id: 'held' }] },
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/schemaVersion schema-version-unsupported'), true)
})

test('scope-duplicate prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'held' }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/1/id scope-duplicate'), true)
})

test('scope-implication-cycle prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'one', implies: ['two'] }, { id: 'two', implies: ['one'] }]),
    'clients.json': clients([{ id: 'c', scopes: ['one'] }]),
    'operations.json': operations([{ id: 'op', requires: ['two'] }]),
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING scopes.json/scopes/0 scope-implication-cycle'), true)
})

test('scope-implication-self prints WARNING and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held', implies: ['held'] }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('WARNING scopes.json/scopes/0/implies/0 scope-implication-self'), true)
})

test('scope-implication-unknown prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held', implies: ['ghost'] }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/0/implies/0 scope-implication-unknown'), true)
})

test('scope-invalid prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, 'not an object']),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/1 scope-invalid'), true)
})

test('scope-pattern-unsupported prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'catalog.*' }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes/1/id scope-pattern-unsupported'), true)
})

test('scope-reference-duplicate prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: ['held', 'held'] }]),
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(stderr.includes('ERROR   clients.json/clients/0/scopes/1 scope-reference-duplicate'), true)
})

test('scope-unused prints INFO and counts no error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'spare' }]),
    'clients.json': ONE,
    'operations.json': OP,
  })

  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(stderr.includes('INFO    scopes.json/scopes/1 scope-unused'), true)
})

test('time-budget-exceeded prints ERROR and counts one error', async () => {
  const scopeList = []
  const grants = []
  for (let index = 0; index < 200; index += 1) {
    scopeList.push({ id: `s${index}` })
    grants.push(`s${index}`)
  }
  const clientList = []
  for (let index = 0; index < 100; index += 1) clientList.push({ id: `c${index}`, scopes: grants })
  const operationList = []
  for (let index = 0; index < 400; index += 1) operationList.push({ id: `o${index}`, requires: grants })

  const { code, report, stderr } = await audit({
    'scopes.json': scopes(scopeList),
    'clients.json': clients(clientList),
    'operations.json': operations(operationList),
  }, ['--max-runtime-ms', '1', '--max-scope-refs', '200'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json time-budget-exceeded'), true)
})

test('too-many-clients prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': clients([{ id: 'one', scopes: ['held'] }, { id: 'two', scopes: ['held'] }]),
    'operations.json': OP,
  }, ['--max-clients', '1'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json/clients too-many-clients'), true)
})

test('too-many-findings prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
    'clients.json': clients([{ id: 'one', scopes: [] }]),
    'operations.json': operations([{ id: 'op', requires: [] }]),
  }, ['--max-findings', '2'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.findings.length, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json too-many-findings'), true)
})

test('too-many-operations prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': HELD,
    'clients.json': ONE,
    'operations.json': operations([{ id: 'op', requires: ['held'] }, { id: 'two', requires: ['held'] }]),
  }, ['--max-operations', '1'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   operations.json/operations too-many-operations'), true)
})

test('too-many-scope-references prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'other' }]),
    'clients.json': clients([{ id: 'one', scopes: ['held'] }, { id: 'two', scopes: ['held', 'other'] }]),
    'operations.json': OP,
  }, ['--max-scope-refs', '1'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   clients.json/clients/1/scopes too-many-scope-references'), true)
})

test('too-many-scopes prints ERROR and counts one error', async () => {
  const { code, report, stderr } = await audit({
    'scopes.json': scopes([{ id: 'held' }, { id: 'other' }]),
    'clients.json': ONE,
    'operations.json': OP,
  }, ['--max-scopes', '1'])

  assert.equal(report.summary.errors, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(stderr.includes('ERROR   scopes.json/scopes too-many-scopes'), true)
})
