import assert from 'node:assert/strict'
import test from 'node:test'

import { hasForbiddenCharacter } from '../src/index.mjs'
import {
  FORBIDDEN,
  apiReport,
  cliReport,
  cliRun,
  client,
  findingsFor,
  fixture,
  operation,
  scope,
  withRoot,
} from './support.mjs'

/**
 * Sanitisation, checked over the whole report rather than over one field.
 *
 * Four tools in this catalog stripped C0 and the line/paragraph separators and
 * let the C1 range through, and one of them sanitised its evidence carefully
 * and left its identifiers raw -- so a page id holding a newline forged whole
 * lines in the human report. Every case below walks the serialised report and
 * asserts that nothing survived anywhere, and two of them count the lines the
 * human report actually printed.
 */

/**
 * The human report separates its lines with U+000A, which is itself in the C0
 * class, so a whole stream cannot be checked as one string. Each printed line is
 * checked instead -- which is the stronger question anyway: the damage a control
 * character does here is to the line it lands in.
 */
const everyLineIsClean = (stream) => stream.split(String.fromCharCode(10)).every((line) => !hasForbiddenCharacter(line))

const base = (extra) => fixture(
  [scope('catalog.read'), extra],
  [client('backoffice', ['catalog.read'])],
  [operation('list-catalog', ['catalog.read'])],
)

test('a forbidden character arriving through an identifier is refused, and none of it reaches the report', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(base(scope(`legacy${character}read`)))

    assert.equal(findingsFor(report, 'identifier-invalid').length, 1, `${name} must be refused as an id`)
    assert.equal(findingsFor(report, 'identifier-invalid')[0].location.pointer, '/scopes/1/id')
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
    assert.equal(JSON.stringify(report).includes('legacy'), false, `${name}: a refused value is described, not reproduced`)
  }
})

test('a forbidden character arriving through an object key is echoed only after it is stripped', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(base({ id: 'legacy.read', [`odd${character}key`]: 1 }))

    const finding = findingsFor(report, 'scope-invalid')[0]
    assert.equal(finding.message.includes('unknown key'), true, `${name} arrives through a key`)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
  }
})

test('a forbidden character arriving through free text reaches evidence only flattened', async () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(base(scope('legacy.read', undefined, `retired${character}in 2024`)))

    const finding = findingsFor(report, 'scope-unused')[0]
    assert.equal(finding.evidence.startsWith('scope: retired'), true, `${name} must leave the text readable`)
    assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false, `${name} must not survive anywhere in the report`)
  }
})

test('a line separator in free text cannot forge a line in the human report', async () => {
  for (const character of [FORBIDDEN['C0 LF'], FORBIDDEN['C1 NEL'], FORBIDDEN['line separator'], FORBIDDEN['paragraph separator']]) {
    const files = base(scope('legacy.read', undefined, `retired${character}ERROR   forged.json fake-rule invented`))

    const result = await withRoot(files, (root) => cliRun(['--root', root]))

    assert.equal(result.code, 0)
    const lines = result.stderr.split('\n')
    assert.equal(lines.at(-1), '', 'the report ends with a newline')
    assert.equal(lines.length, 5, 'three summary lines, one finding, and nothing forged')
    assert.equal(lines.filter((line) => line.startsWith('ERROR')).length, 0)
    assert.equal(everyLineIsClean(result.stderr), true)
  }
})

test('a bidi override cannot reverse what the human report prints', async () => {
  const files = base(scope('legacy.read', undefined, `${FORBIDDEN['bidi RLO']}retired`))
  const result = await withRoot(files, (root) => cliRun(['--root', root]))

  assert.equal(result.stderr.includes('scope: retired'), false, 'evidence is not printed on the summary lines')
  assert.equal(everyLineIsClean(result.stderr), true)
  assert.equal(result.stderr.includes('INFO'), true)
})

test('an argument is flattened before it reaches a stream, because argv never passes through a finding', async () => {
  const result = await cliRun([`--unknown${FORBIDDEN['C0 LF']}option`, '--root', '.'])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(everyLineIsClean(result.stderr), true)
  assert.equal(result.stderr.startsWith('Unknown option "--unknown option"'), true)
})

test('a file name carrying a forbidden character is refused as configuration, before any read', async () => {
  const result = await cliRun(['--root', '.', '--scopes', `scopes${FORBIDDEN['line separator']}.json`])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error never had a subject, so stdout stays empty')
  assert.equal(result.stderr.includes('must not contain a control, separator or bidi character'), true)
  assert.equal(everyLineIsClean(result.stderr), true)
})

test('nothing forbidden survives in a report that raises many different rules at once', async () => {
  const { report } = await cliReport(fixture(
    [scope(`a${FORBIDDEN['C1 CSI']}one`), scope('b.two', [`c${FORBIDDEN.DEL}three`]), scope('d.four', undefined, `spare${FORBIDDEN['C0 ESC']}scope`)],
    [client('one', [`e${FORBIDDEN['bidi isolate']}five`, 'b.two'])],
    [operation('needs', [`f${FORBIDDEN['C0 NUL']}six`])],
  ))

  assert.equal(hasForbiddenCharacter(JSON.stringify(report)), false)
  assert.equal(report.findings.length > 4, true, 'several rules must fire for this case to mean anything')
  assert.equal(report.status, 'incomplete')
})
