import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { clean, cliRun, withRoot } from './support.mjs'

/**
 * A parse failure must not reproduce the file it failed on.
 *
 * V8 reports a `JSON.parse` failure two ways. One names a position and says
 * nothing about the content. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * document when it is short, a ten-character prefix when it is not. An exported
 * scope, client or operation file short enough to be only a credential was
 * therefore published in full by the `input-not-json` finding that failed to
 * read it, on exactly the path an untrusted or malformed file takes.
 *
 * `excerpt` never fixed this: it flattens control characters and cuts from the
 * end, while the quoted input sits at the front of the message. The canary
 * below is AWS's published documentation placeholder, not a key.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const INPUT_FILES = ['scopes.json', 'clients.json', 'operations.json']

/** Every prefix of the canary down to eight characters, longest first. */
function prefixes(value) {
  const found = []
  for (let length = value.length; length >= 8; length -= 1) found.push(value.slice(0, length))
  return found
}

function assertNoCanary(result, label) {
  for (const prefix of prefixes(CANARY)) {
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('an input that is only a credential is not echoed by the finding that read it', async () => {
  for (const name of INPUT_FILES) {
    await withRoot({ ...clean(), [name]: CANARY }, async (root) => {
      const json = await cliRun(['--root', root, '--json'])
      assert.equal(json.code, 2, name)
      assertNoCanary(json, `${name} json report`)

      const human = await cliRun(['--root', root])
      assert.equal(human.code, 2, name)
      assertNoCanary(human, `${name} human report`)

      const finding = JSON.parse(json.stdout).findings.find((item) => item.ruleId === 'input-not-json')
      assert.equal(finding.message, `${name} is not valid JSON: unexpected token 'A' at the start of the document`)
    })
  }
})

test('a longer input is not echoed by its ten-character prefix either', async () => {
  const longer = `${CANARY} and a great deal of trailing content nobody should read back`
  await withRoot({ ...clean(), 'scopes.json': longer }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    assert.equal(result.code, 2)
    assertNoCanary(result, 'long input')
  })
})

test('the position, line and column survive, because a parse error that says nothing is a defect', async () => {
  const broken = '{"schemaVersion": "1", "token": "hunter2-correct-horse" "scopes": []}'
  await withRoot({ ...clean(), 'scopes.json': broken }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'input-not-json')
    assert.match(finding.message, /at position \d+ \(line \d+ column \d+\)/)
    assert.equal(finding.message.includes('hunter2'), false)
  })
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const cases = [
    [CANARY, "unexpected token 'A' at the start of the document"],
    ['password=hunter2-correct-horse', "unexpected token 'p' at the start of the document"],
    ['', 'Unexpected end of JSON input'],
    ['{"a": 1', "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)"],
  ]
  for (const [document, expected] of cases) {
    try {
      JSON.parse(document)
      assert.fail(`${document} parsed`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected, JSON.stringify(document))
    }
  }

  // A message this tool has never seen still yields something printable, and an
  // error with no message at all does not throw on its way into a finding.
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
