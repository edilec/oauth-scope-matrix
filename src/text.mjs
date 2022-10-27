/**
 * Decoding, sanitising, ordering and identifier shapes.
 *
 * Nothing in this module touches the filesystem, the network, the locale or a
 * clock. Every value it handles arrived in a file this tool did not write, so
 * every value it returns is treated as data on its way to a report and never as
 * something that may shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * reads ICU data that differs between Node builds and between hosts, and it
 * weighs punctuation differently from its code point: under English collation
 * `a_read` sorts before `a-read`, and `Z` sorts after `a`. Scope ids in this
 * tool are allowed to carry upper case, `-` and `_`, so a collated report would
 * list a different least-required set on a different machine. Every order this
 * package exposes is decided here.
 *
 * Neither spelling of the locale-aware comparison appears anywhere in this
 * package, and `test/ordering.test.mjs` pins what the tool *emits* rather than
 * what its source says -- a scan of the source cannot tell one comparator from
 * the other, so a scan is not the test.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and the
 * rest are invisible in an editor. Spelling each one out keeps this file plain
 * ASCII and keeps the list reviewable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in the
 *   human report, ESC opens a terminal escape sequence, NUL truncates a value
 *   in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   need no help: U+0085 NEL is a line break to a great many consumers, and
 *   U+009B is the 8-bit CSI, a terminal control introducer that needs no ESC in
 *   front of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a scope named `repo.read` can be displayed as something else
 *   entirely while the matrix compares the real value. Ordinary right-to-left
 *   text -- Arabic, Hebrew -- needs none of these: the letters carry their own
 *   direction, so refusing the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- scope ids,
 * client ids, operation ids, file names, pointers, messages, suggestions and
 * evidence alike, not only an excerpt field. Tab, newline and carriage return
 * are left out of this class deliberately: `excerpt` collapses them into a
 * single space in the very next step, which is the same result by a shorter
 * route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same four classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * gets no second pass. A scope id that prints differently from the value the
 * matrix compared is a scope nobody can audit, so it is refused at the door.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * Detects any of the four classes anywhere in a string. Exported so tests can
 * walk an entire report and assert that nothing survived anywhere, rather than
 * checking the one field a developer remembered to sanitise.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN_IN_IDENTIFIER.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 120
export const MAX_DESCRIPTION_LENGTH = 300

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every id, file name, pointer, message and piece of evidence that reaches a
 * finding goes through here. A tool in this catalog sanitised its evidence
 * carefully and left its identifiers raw, so a record id holding a newline
 * printed two lines into the human report and invented a finding that was never
 * emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * What a `JSON.parse` failure may say about a file this tool did not write.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * document when the document is short, a ten-character prefix when it is not.
 * An exported scope, client or operation file short enough to be only a
 * credential is therefore reproduced in full by its own error message, on
 * exactly the path an untrusted or malformed file takes. `excerpt` does not
 * help: it flattens control characters and cuts from the end, while the quoted
 * input sits at the front.
 *
 * The position is the useful half and carries no content, so it is kept
 * whenever V8 offers one. The quoted half never leaves this function.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? 'could not be parsed')
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  const token = /^Unexpected token (.+?), ".*?"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) return `unexpected token ${token[1]} at the start of the document`
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'the document could not be parsed as JSON'
}

/**
 * The identifier alphabet: scope ids, client ids and operation ids.
 *
 * Deliberately wide enough to hold the scope spellings real providers use --
 * `repo:read`, `https://www.googleapis.com/auth/drive.readonly`,
 * `admin.directory.user`, `Files.ReadWrite.All` -- which means upper case, `-`
 * and `_` all occur, which in turn is why ordering in this package is decided
 * by code unit and pinned by what the tool emits.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+_-]*$/

export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (FORBIDDEN_IN_IDENTIFIER.test(value)) return false
  return IDENTIFIER.test(value)
}

/**
 * Recognise a scope written as a pattern rather than as a name.
 *
 * `repo:*`, `admin.*`, `projects/{id}/read` and `read?` are all real spellings
 * in real providers' documentation, and this tool supports none of them: it
 * compares declared names, and it expands only the implications that were
 * declared. A pattern is therefore reported as an unsupported construct that
 * makes the run incomplete -- it is never quietly matched against anything,
 * because guessing which names a pattern covers is exactly the inference this
 * tool exists not to make.
 */
export function looksLikePattern(value) {
  return typeof value === 'string' && /[*?{}[\]]/.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the input ever was. Echoing the value back hands
 * that content a wider audience than it had, on exactly the fields whose
 * validation exists to keep something unexpected out of the report. The pointer
 * on the finding names the exact position in the file, which is all a reader
 * needs; the value stays in the file, where it started.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains a
 * replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. The decoder decides; the decoded text never
 * gets a vote. Every file this tool opens goes through here -- all three
 * documents, with no exception for the one a reviewer thinks of as
 * configuration, because that is precisely where a sibling tool hardened its
 * data path and forgot.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
