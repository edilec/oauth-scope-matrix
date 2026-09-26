/**
 * oauth-scope-matrix -- compare exported scope definitions, client grants and
 * operation requirements, and report the least-required set for each operation,
 * the operations no grant covers, and the grants nothing requires.
 *
 * This package talks to nobody. It requests no token, reads no token, and opens
 * no socket; the three documents it reads are exports somebody produced, and
 * every conclusion in the report is a conclusion about those three documents.
 * `README.md` and `docs/scope-matrix-rules.md` say in their own words what that
 * does and does not establish.
 *
 * Two properties are load-bearing and are pinned by behaviour rather than by
 * declaration:
 *
 * - **Implication is declared.** Nothing here infers that one scope implies
 *   another from the shape of its name. A scope that is neither declared nor
 *   implied is unknown, it is never treated as held, and a run that meets one
 *   is incomplete rather than green.
 * - **Order is by code unit.** Scope names carry upper case, `-` and `_`, all
 *   of which collate differently from their code points, so a locale-aware
 *   comparison would produce a different least-required set on a different
 *   machine.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { compileDocument } from './documents.mjs'
import { buildImplicationGraph } from './implication.mjs'
import { buildMatrix } from './matrix.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, parseFailureDetail } from './text.mjs'

export const TOOL_ID = 'oauth-scope-matrix'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_SCOPES_NAME = 'scopes.json'
export const DEFAULT_CLIENTS_NAME = 'clients.json'
export const DEFAULT_OPERATIONS_NAME = 'operations.json'

/**
 * Limits, each enforced and each reported by name when it is reached.
 *
 * Exceeding one is never a silent truncation: it produces a finding that names
 * the limit and marks the run `incomplete`, because a partial walk is not
 * evidence that the part nobody walked was fine.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxClients: 200,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxImplicationDepth: 16,
  maxOperations: 1000,
  maxRuntimeMs: 10000,
  maxScopeRefs: 50,
  maxScopes: 500,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxClients: 2000,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxImplicationDepth: 64,
  maxOperations: 20000,
  maxRuntimeMs: 600000,
  maxScopeRefs: 500,
  maxScopes: 5000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and demoting one of the error rules below turns "this client holds a scope
 * nobody can describe" into a green build with every test still passing. Every
 * finding takes its severity from here, and an unknown rule id throws.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is not the test: a
 * table, a catalog and a test's expected map are three declarations, and one
 * edit that changes all three leaves every assertion that compares them
 * satisfied. `test/severity-exit.test.mjs` and `test/severity-word.test.mjs`
 * drive real inputs through the real binary and pin the exit code, the error
 * count and the printed severity word with literal values instead.
 */
export const RULE_SEVERITY = Object.freeze({
  'client-duplicate': 'error',
  'client-grants-nothing': 'warning',
  'client-invalid': 'error',
  'document-invalid': 'error',
  'grant-implied-by-another': 'warning',
  'grant-scope-unknown': 'error',
  'grant-unused': 'warning',
  'identifier-invalid': 'error',
  'implication-depth-exceeded': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'no-clients': 'error',
  'no-operations-evaluated': 'error',
  'no-scopes': 'error',
  'operation-duplicate': 'error',
  'operation-invalid': 'error',
  'operation-requires-nothing': 'warning',
  'operation-uncovered': 'error',
  'path-escapes-root': 'error',
  'requirement-redundant': 'warning',
  'requirement-scope-unknown': 'error',
  'requirement-unsupported': 'error',
  'schema-version-unsupported': 'error',
  'scope-duplicate': 'error',
  'scope-implication-cycle': 'warning',
  'scope-implication-self': 'warning',
  'scope-implication-unknown': 'error',
  'scope-invalid': 'error',
  'scope-pattern-unsupported': 'error',
  'scope-reference-duplicate': 'error',
  'scope-unused': 'info',
  'time-budget-exceeded': 'error',
  'too-many-clients': 'error',
  'too-many-findings': 'error',
  'too-many-operations': 'error',
  'too-many-scope-references': 'error',
  'too-many-scopes': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['clients', 'clock', 'limits', 'operations', 'root', 'scopes'])

/** Raised when the run passes its time budget; turned into a finding by the caller. */
class TimeBudgetExceeded extends Error {}

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(`Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against a path
 * that has not been resolved refuses legitimate files whenever the root is
 * reached through a symbolic link -- a `/var` that is really `/private/var` is
 * enough -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  const parts = normalize(name).split(/[\\/]/)
  if (parts.includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised evidence carefully and left identifiers raw, so a record id holding
 * a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/scope-matrix-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * The message is part of the key because several rules anchor more than one
 * finding at the same pointer on purpose -- a redundant requirement is a
 * relation between two entries of a list, so it belongs to the list rather than
 * to one index of it. No two findings share all four components, and `sort` is
 * stable, so even a tie would preserve the emission order, which is itself
 * fixed by the documents.
 */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message)
  )
}

function buildReport(sink, state, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: state.files.operations,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the inputs.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      scopes: state.scopes,
      clients: state.clients,
      operations: state.operations,
      covered: state.covered,
      uncovered: state.uncovered,
      unevaluated: state.unevaluated,
      extraGrants: state.extraGrants,
    },
    matrix: state.matrix,
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an unresolved
 * target refuses legitimate files, so the root is resolved too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may still exist as a link that resolves nowhere. Confine the
    // nearest existing ancestor first, so a symlinked parent directory cannot
    // decide where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

function emptyState(files) {
  return {
    files,
    checked: 0,
    scopes: 0,
    clients: 0,
    operations: 0,
    covered: 0,
    uncovered: 0,
    unevaluated: 0,
    extraGrants: 0,
    matrix: { scopes: [], operations: [], clients: [] },
    incomplete: false,
  }
}

/**
 * Compare a scope catalog, a set of client grants and a set of operation
 * requirements.
 *
 * @param {object} options
 * @param {string} options.root Directory holding the three documents.
 * @param {string} [options.scopes] Scope catalog, relative to the root.
 * @param {string} [options.clients] Client grants, relative to the root.
 * @param {string} [options.operations] Operation requirements, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @param {Function} [options.clock] Monotonic millisecond source for the time
 *   budget. Injected so a test can drive the budget without waiting, and so
 *   that nothing in this package reads a wall clock.
 * @returns {Promise<object>} the report.
 */
export async function auditScopeMatrix(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('clock must be a function returning milliseconds')

  const names = {
    scopes: validateName(options.scopes ?? DEFAULT_SCOPES_NAME, '--scopes'),
    clients: validateName(options.clients ?? DEFAULT_CLIENTS_NAME, '--clients'),
    operations: validateName(options.operations ?? DEFAULT_OPERATIONS_NAME, '--operations'),
  }

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const budget = {
    check() {
      if (clock() - started > limits.maxRuntimeMs) throw new TimeBudgetExceeded()
    },
  }

  const sink = new FindingSink()
  const state = emptyState(names)

  const parsed = {}
  for (const kind of ['clients', 'operations', 'scopes']) {
    const name = names[kind]
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      // (1) An input that could not be reached is missing evidence, not a
      // verdict about it.
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep all three documents inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      parsed[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    // (2) Unreadable, undecodable or unparseable bytes are missing evidence too.
    if (loaded === null) state.incomplete = true
    parsed[kind] = loaded
  }

  const compiled = {}
  for (const kind of ['clients', 'operations', 'scopes']) {
    if (parsed[kind] === null) {
      compiled[kind] = null
      continue
    }
    const document = compileDocument(sink, names[kind], kind, parsed[kind].value, limits)
    // (3) A document whose shape, version or size this build cannot take is a
    // document nothing was learned from.
    if (document === null) state.incomplete = true
    compiled[kind] = document
  }

  if (compiled.scopes !== null) state.scopes = compiled.scopes.entries.length
  if (compiled.clients !== null) state.clients = compiled.clients.entries.length
  if (compiled.operations !== null) state.operations = compiled.operations.entries.length

  for (const kind of ['clients', 'operations', 'scopes']) {
    const document = compiled[kind]
    if (document === null) continue
    // (4) An entry that did not compile was not compared against anything.
    // Reporting `fail` here would claim the whole document was read when part
    // of it was refused.
    if (document.entries.length !== document.declared) state.incomplete = true
    // (5) A reference that is a pattern or not a name at all leaves a grant or
    // a requirement partly unknown, which is not the same as knowing it is
    // empty.
    for (const entry of document.entries) if (entry.refsRefused > 0) state.incomplete = true
  }

  if (compiled.scopes !== null && compiled.clients !== null && compiled.operations !== null) {
    try {
      const graph = buildImplicationGraph(sink, names.scopes, compiled.scopes.entries, compiled.scopes.byId, limits, budget)
      // (6) An implication chain this build stopped walking leaves every
      // effective set below it a floor rather than an answer.
      if (graph.depthExceeded) state.incomplete = true
      // (7) An implication to a scope nobody declared is an unknown, and an
      // unknown is never assumed to be safe.
      if (graph.unknownEdges > 0) state.incomplete = true

      const result = buildMatrix(sink, names, compiled.scopes, compiled.clients, compiled.operations, graph, budget)
      state.checked = result.checked
      state.covered = result.covered
      state.uncovered = result.uncovered
      state.unevaluated = result.unevaluated
      state.extraGrants = result.extraGrants
      state.matrix = result.matrix

      // (8) An operation whose requirement names an unknown scope was not
      // decided either way.
      if (result.unevaluated > 0) state.incomplete = true

      // (9) Any grant this run could not describe leaves that client's reach a
      // floor, so an "uncovered" verdict about it is a floor too. Counted from
      // the findings rather than re-derived, so the flag and the reason cannot
      // drift apart.
      if (sink.rows.some((row) => row.ruleId === 'grant-scope-unknown')) state.incomplete = true

      /**
       * (10) The vacuous pass, refused explicitly.
       *
       * Three documents that all compile, with no operation left to evaluate,
       * would otherwise report `pass` with `checked: 0` -- green on no evidence
       * at all. This is the only thing standing between that input and a green
       * build, so it is an error, it marks the run incomplete, and
       * `test/incomplete.test.mjs` fails if either half is removed.
       *
       * It is confined to runs that reached the matrix: a run whose documents
       * could not be read or compiled has already said so under its own rule,
       * and repeating it here would backstop those flags, so removing one of
       * them would change nothing observable and no test could catch it.
       */
      if (state.checked === 0) {
        state.incomplete = true
        sink.add({
          file: names.operations,
          pointer: '/operations',
          ruleId: 'no-operations-evaluated',
          message: `The run evaluated 0 of ${state.operations} declared operation(s), so it has no evidence to be green on.`,
          suggestion: 'Declare the operations this matrix is meant to cover, and fix whatever stopped the ones that are there from being evaluated.',
        })
      }
    } catch (error) {
      if (!(error instanceof TimeBudgetExceeded)) throw error
      // (11) A run that stopped early compared less than it was asked to.
      state.incomplete = true
      sink.add({
        file: names.operations,
        ruleId: 'time-budget-exceeded',
        message: `The comparison passed the maxRuntimeMs budget of ${limits.maxRuntimeMs} and stopped; the matrix below is partial.`,
        suggestion: 'Raise --max-runtime-ms, or split the documents.',
      })
    }
  }

  return buildReport(sink, state, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `scopes ${excerpt(extra.scopes ?? DEFAULT_SCOPES_NAME, 80)}: ${summary.scopes} declared.`,
    `clients ${excerpt(extra.clients ?? DEFAULT_CLIENTS_NAME, 80)}: ${summary.clients} declared, ${summary.extraGrants} grant(s) nothing here needs.`,
    `operations ${excerpt(extra.operations ?? DEFAULT_OPERATIONS_NAME, 80)}: ${summary.checked} of ${summary.operations} evaluated, ${summary.covered} covered, ${summary.uncovered} uncovered, ${summary.unevaluated} not decided. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { buildImplicationGraph, closureOf } from './implication.mjs'
export { buildMatrix } from './matrix.mjs'
export {
  CLIENT_DOCUMENT_KEYS, CLIENT_KEYS, DOCUMENT_SCHEMA_VERSION, OPERATION_DOCUMENT_KEYS,
  OPERATION_KEYS, SCOPE_DOCUMENT_KEYS, SCOPE_KEYS, compileDocument,
} from './documents.mjs'
export {
  EXCERPT_LIMIT, MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8,
  describeValue, excerpt, hasForbiddenCharacter, isIdentifier, isPlainObject, looksLikePattern,
  parseFailureDetail,
} from './text.mjs'
