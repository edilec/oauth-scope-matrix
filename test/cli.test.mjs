import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import {
  cliRun,
  client,
  clientDocument,
  fixture,
  operation,
  operationDocument,
  projectDirectory,
  scope,
  scopeDocument,
  withRoot,
} from './support.mjs'

const matrix = () => fixture(
  [scope('catalog.read'), scope('catalog.write', ['catalog.read'])],
  [client('backoffice', ['catalog.write'])],
  [operation('list-catalog', ['catalog.read']), operation('edit-catalog', ['catalog.write'])],
)

test('--help goes to stdout, exits 0, and names every flag the tool accepts', async () => {
  for (const flag of ['-h', '--help']) {
    const { code, stdout, stderr } = await cliRun([flag])

    assert.equal(code, 0)
    assert.equal(stderr, '')
    for (const name of [
      '--root', '--scopes', '--clients', '--operations', '--json',
      '--max-file-bytes', '--max-scopes', '--max-clients', '--max-operations',
      '--max-scope-refs', '--max-implication-depth', '--max-runtime-ms', '--max-findings',
    ]) {
      assert.equal(stdout.includes(name), true, `--help must document ${name}`)
    }
    assert.equal(stdout.includes('No token is ever requested'), true)
    assert.equal(stdout.includes('never a "pass"'), true)
  }
})

test('--version reports the version in the manifest', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  const { code, stdout } = await cliRun(['--version'])

  assert.equal(code, 0)
  assert.equal(stdout, `${manifest.version}\n`)
})

test('stdout carries the JSON report and nothing else', async () => {
  const { code, stdout, stderr } = await withRoot(matrix(), (root) => cliRun(['--root', root]))

  assert.equal(code, 0)
  assert.equal(stdout.endsWith('}\n'), true)
  const report = JSON.parse(stdout)
  assert.equal(report.tool, 'oauth-scope-matrix')
  assert.equal(report.schemaVersion, '1')
  assert.equal(stderr.includes('status pass'), true, 'the human summary is on stderr, where it belongs')
})

test('--json suppresses the human summary without changing stdout', async () => {
  const plain = await withRoot(matrix(), (root) => cliRun(['--root', root]))
  const quiet = await withRoot(matrix(), (root) => cliRun(['--root', root, '--json']))

  assert.equal(plain.stdout, quiet.stdout)
  assert.equal(quiet.stderr, '')
  assert.notEqual(plain.stderr, '')
})

test('a non-empty stderr is correct, and it never carries report data', async () => {
  const { stderr } = await withRoot(fixture(
    [scope('catalog.read'), scope('spare.scope', undefined, 'Nothing uses this.')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read'])],
  ), (root) => cliRun(['--root', root]))

  const lines = stderr.split('\n')
  assert.equal(lines[0].startsWith('scopes scopes.json: 2 declared.'), true)
  assert.equal(lines[3].startsWith('INFO    scopes.json/scopes/1 scope-unused'), true)
  assert.equal(stderr.includes('Nothing uses this.'), false, 'evidence stays in the JSON report')
})

test('the three document names are configurable and default sensibly', async () => {
  const named = await withRoot({
    'a.json': scopeDocument([scope('catalog.read')]),
    'b.json': clientDocument([client('backoffice', ['catalog.read'])]),
    'c.json': operationDocument([operation('list-catalog', ['catalog.read'])]),
  }, (root) => cliRun(['--root', root, '--scopes', 'a.json', '--clients', 'b.json', '--operations', 'c.json', '--json']))

  assert.equal(named.code, 0)
  assert.equal(JSON.parse(named.stdout).status, 'pass')

  const defaulted = await withRoot(matrix(), (root) => cliRun(['--root', root, '--json']))
  assert.equal(defaulted.code, 0)
})

test('a bad invocation exits 2 with an empty stdout and the help on stderr', async () => {
  const cases = [
    { args: [], expect: '--root is required' },
    { args: ['--root'], expect: '--root requires a value' },
    { args: ['--root', '.', '--nope'], expect: 'Unknown option "--nope"' },
    { args: ['--root', '.', '--max-scopes', 'lots'], expect: '--max-scopes requires a positive integer' },
    { args: ['--root', '.', '--max-scopes', '0'], expect: '--max-scopes requires a positive integer' },
    { args: ['--root', '.', '--json', '--json', '--root', '.'], expect: '--root was given more than once' },
  ]

  for (const { args, expect } of cases) {
    const { code, stdout, stderr } = await cliRun(args)
    assert.equal(code, 2, `${args.join(' ')} must be a configuration error`)
    assert.equal(stdout, '', 'a run that never had a subject reports nothing')
    assert.equal(stderr.includes(expect), true, `${args.join(' ')} must say why`)
  }
})

test('a limit past its hard cap is a configuration error, not a clamp', async () => {
  const { code, stdout, stderr } = await withRoot(matrix(), (root) =>
    cliRun(['--root', root, '--max-scopes', '5001']))

  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.equal(stderr.includes('limits.maxScopes must be an integer between 1 and 5000'), true)
})

test('the three exit codes map to the three statuses', async () => {
  const passing = await withRoot(matrix(), (root) => cliRun(['--root', root, '--json']))
  assert.equal(passing.code, 0)
  assert.equal(JSON.parse(passing.stdout).status, 'pass')

  const failing = await withRoot(fixture(
    [scope('catalog.read'), scope('need')],
    [client('backoffice', ['catalog.read'])],
    [operation('list-catalog', ['catalog.read']), operation('gap', ['need'])],
  ), (root) => cliRun(['--root', root, '--json']))
  assert.equal(failing.code, 1)
  assert.equal(JSON.parse(failing.stdout).status, 'fail')

  const unknown = await withRoot(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read', 'ghost'])],
    [operation('list-catalog', ['catalog.read'])],
  ), (root) => cliRun(['--root', root, '--json']))
  assert.equal(unknown.code, 2)
  assert.equal(JSON.parse(unknown.stdout).status, 'incomplete')
})

test('an incomplete run says so on stderr as well, so a human is not left reading a green summary', async () => {
  const { stderr } = await withRoot(fixture(
    [scope('catalog.read')],
    [client('backoffice', ['catalog.read', 'ghost'])],
    [operation('list-catalog', ['catalog.read'])],
  ), (root) => cliRun(['--root', root, '--json']))

  assert.equal(stderr.includes('incomplete: 1 of 1 declared operation(s) were evaluated; this run is not a pass.'), true)
})

/**
 * The documented definition of a pass, against the pass the tool actually gives.
 *
 * Both `--help` and `README.md` used to define a pass as three conjuncts, the
 * third being that nothing is granted this matrix does not need -- and that one
 * is not enforced: `grant-unused` and `grant-implied-by-another` are warnings,
 * so the run below exits 0 with `extraGrants: 1` while the summary line on
 * stderr says out loud that a grant here is spare. Two thirds of a sentence
 * being true is how a reader ends up trusting the third.
 *
 * The behavioural half below pins the pass. The textual half fails if either
 * document goes back to promising more than the exit code delivers.
 */
test('a pass does not promise that nothing spare is granted, and both documents say so', async () => {
  for (const ruleId of ['grant-implied-by-another', 'grant-unused']) {
    assert.notEqual(RULE_SEVERITY[ruleId], 'error', `${ruleId} decides what the sentence below may claim`)
  }

  const { code, stdout, stderr } = await withRoot(fixture(
    [scope('held'), scope('spare')],
    [client('one', ['held', 'spare'])],
    [operation('op', ['held'])],
  ), (root) => cliRun(['--root', root]))
  const report = JSON.parse(stdout)

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.extraGrants, 1, 'a passing run really can carry a grant nothing needs')
  assert.equal(stderr.includes('1 grant(s) nothing here needs.'), true)

  const help = (await cliRun(['--help'])).stdout
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  for (const [name, text] of [['--help', help], ['README.md', readme]]) {
    // Both documents wrap, so the claim is read off the text with its line
    // breaks collapsed; a sentence that only escapes the check by being folded
    // across two lines is the same sentence to a reader.
    const flat = text.replace(/\s+/g, ' ')
    assert.equal(
      flat.includes('nothing is granted that this matrix does not need'),
      false,
      `${name} claims a pass means no spare grant, and the run above passes with one`,
    )
    assert.equal(flat.includes('summary.extraGrants'), true, `${name} must point at the count that does carry this`)
    assert.equal(flat.includes('withhold the pass'), true, `${name} must say a spare grant does not withhold the pass`)
  }
})

test('the report is byte-identical across two runs of the real binary', async () => {
  const first = await withRoot(matrix(), (root) => cliRun(['--root', root, '--json']))
  const second = await withRoot(matrix(), (root) => cliRun(['--root', root, '--json']))

  assert.equal(first.stdout, second.stdout)
})
