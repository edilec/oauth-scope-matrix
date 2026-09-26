import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT,
  MAX_IDENTIFIER_LENGTH,
  byCodeUnit,
  decodeUtf8,
  describeValue,
  excerpt,
  hasForbiddenCharacter,
  isIdentifier,
  isPlainObject,
  looksLikePattern,
} from '../src/text.mjs'
import { FORBIDDEN } from './support.mjs'

test('code-unit order is the order this package uses, including where collation disagrees', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.equal(byCodeUnit('b', 'a') > 0, true)
})

test('every class named by the report contract is detected and stripped', () => {
  for (const [name, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`before${character}after`), true, `${name} must be detected`)
    assert.equal(hasForbiddenCharacter(excerpt(`before${character}after`)), false, `${name} must not survive excerpt`)
    assert.equal(isIdentifier(`before${character}after`), false, `${name} must not pass as an identifier`)
  }
})

test('excerpt collapses whitespace, trims and bounds', () => {
  assert.equal(excerpt('  a\t b \n c  '), 'a b c')
  assert.equal(excerpt(''), '')
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT)).length, EXCERPT_LIMIT)
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).length, EXCERPT_LIMIT + 3)
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).endsWith('...'), true)
  assert.equal(excerpt('abcdef', 3), 'abc...')
})

test('the identifier alphabet holds the scope spellings real providers use', () => {
  for (const value of [
    'repo',
    'repo:read',
    'admin.directory.user',
    'Files.ReadWrite.All',
    'https://www.googleapis.com/auth/drive.readonly',
    'user_impersonation',
    'a-b',
    'a_b',
    'Z9',
  ]) {
    assert.equal(isIdentifier(value), true, `${value} is a name a provider really uses`)
  }
})

test('an identifier is bounded on both sides and must start with a letter or digit', () => {
  assert.equal(isIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH)), true)
  assert.equal(isIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH + 1)), false)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier('.leading'), false)
  assert.equal(isIdentifier('-leading'), false)
  assert.equal(isIdentifier(' padded '), false)
  assert.equal(isIdentifier('has space'), false)
  assert.equal(isIdentifier(42), false)
  assert.equal(isIdentifier(null), false)
})

test('a pattern is recognised as a pattern rather than mistaken for a name', () => {
  for (const value of ['repo:*', 'admin.*', 'projects/{id}/read', 'read?', 'a[b]']) {
    assert.equal(looksLikePattern(value), true, `${value} is a pattern`)
    assert.equal(isIdentifier(value), false, `${value} is not a name`)
  }
  assert.equal(looksLikePattern('catalog.read'), false)
})

test('a refused value is described, never reproduced', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue([1, 2]), 'an array of 2 item(s)')
  assert.equal(describeValue({}), 'an object')
  const secretish = 'ya29.A0ARrdaM-not-a-real-token'
  assert.equal(describeValue(secretish).includes('ya29'), false)
  assert.equal(describeValue(secretish), `a string of ${secretish.length} character(s)`)
})

test('decoding is the decoder decision and never an inference from decoded text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])).ok, false)
  // A file that legitimately holds U+FFFD decodes; a tool that hunted for the
  // replacement character instead would call this one undecodable.
  const legitimate = new TextEncoder().encode('"�"')
  assert.equal(decodeUtf8(legitimate).ok, true)
  assert.equal(decodeUtf8(legitimate).text, '"�"')
})

test('a plain object is told apart from the things that merely look like one', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
  assert.equal(isPlainObject('{}'), false)
  // The two absent values and the primitives answer rather than throw. This is
  // an exported predicate, and a guard that reaches the prototype lookup with
  // nothing to look up turns a "no" into an exception at the caller.
  assert.equal(isPlainObject(undefined), false)
  assert.equal(isPlainObject(42), false)
  assert.equal(isPlainObject(true), false)
  assert.equal(isPlainObject(() => {}), false)
})
