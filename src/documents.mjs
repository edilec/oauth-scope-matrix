/**
 * The three input documents, compiled from parsed JSON into the shapes the
 * matrix works on.
 *
 * Everything here is shape and vocabulary: is this an object, does it declare a
 * version this build understands, is every key one of the documented ones, is
 * every id an identifier rather than a pattern. Nothing here knows whether a
 * scope exists, because that is a question about the catalog as a whole and it
 * is answered in `matrix.mjs`.
 *
 * The supported input dialect is deliberately small and it is declared rather
 * than approximated. A construct this build does not implement -- a wildcard
 * scope, an alternative-requirement object -- is reported as unsupported and
 * makes the run incomplete. It is never quietly treated as satisfied, which is
 * the failure mode that makes a bounded validator dangerous instead of honest.
 */

import {
  MAX_DESCRIPTION_LENGTH,
  byCodeUnit,
  describeValue,
  excerpt,
  isIdentifier,
  isPlainObject,
  looksLikePattern,
} from './text.mjs'

/** The only document version this build reads. Anything else is unsupported, not ignored. */
export const DOCUMENT_SCHEMA_VERSION = '1'

export const SCOPE_DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'scopes'])
export const CLIENT_DOCUMENT_KEYS = Object.freeze(['clients', 'schemaVersion'])
export const OPERATION_DOCUMENT_KEYS = Object.freeze(['operations', 'schemaVersion'])

export const SCOPE_KEYS = Object.freeze(['description', 'id', 'implies'])
export const CLIENT_KEYS = Object.freeze(['description', 'id', 'scopes'])
export const OPERATION_KEYS = Object.freeze(['description', 'id', 'requires'])

/**
 * Requirement shapes this build recognises and does not implement.
 *
 * A `requires` written as `{"anyOf": [...]}` is a real thing to want and this
 * tool does not evaluate it. Left to the generic "not an array" branch it would
 * be reported as a malformed operation, which is both wrong and quietly
 * misleading -- the operation is well formed and this tool is the limited
 * party. It is named as unsupported instead, and the operation is not evaluated
 * for coverage at all.
 */
const ALTERNATIVE_KEYWORDS = Object.freeze(['allOf', 'anyOf', 'if', 'not', 'oneOf'])

const SPECS = Object.freeze({
  scopes: {
    listKey: 'scopes',
    documentKeys: SCOPE_DOCUMENT_KEYS,
    entryKeys: SCOPE_KEYS,
    refKey: 'implies',
    refRequired: false,
    invalidRule: 'scope-invalid',
    duplicateRule: 'scope-duplicate',
    limitRule: 'too-many-scopes',
    limitKey: 'maxScopes',
    noun: 'scope',
  },
  clients: {
    listKey: 'clients',
    documentKeys: CLIENT_DOCUMENT_KEYS,
    entryKeys: CLIENT_KEYS,
    refKey: 'scopes',
    refRequired: true,
    invalidRule: 'client-invalid',
    duplicateRule: 'client-duplicate',
    limitRule: 'too-many-clients',
    limitKey: 'maxClients',
    noun: 'client',
  },
  operations: {
    listKey: 'operations',
    documentKeys: OPERATION_DOCUMENT_KEYS,
    entryKeys: OPERATION_KEYS,
    refKey: 'requires',
    refRequired: true,
    invalidRule: 'operation-invalid',
    duplicateRule: 'operation-duplicate',
    limitRule: 'too-many-operations',
    limitKey: 'maxOperations',
    noun: 'operation',
  },
})

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

/**
 * Compile one reference list -- `implies`, a client's `scopes`, an operation's
 * `requires`.
 *
 * A reference is a scope *name*. It is checked for shape only: whether the name
 * exists in the catalog is decided later, and a name that does not exist is a
 * finding of its own rather than something this function may drop.
 *
 * Returns `null` when the list itself is unusable, which refuses the whole
 * entry. Returning a shorter list instead would mean a client silently granted
 * fewer scopes than it declares, and the report would then describe permissions
 * nobody configured.
 */
function compileReferences(sink, file, pointer, spec, entry, limits) {
  const raw = entry[spec.refKey]

  if (raw === undefined) {
    if (spec.refRequired) {
      sink.add({
        file,
        pointer,
        ruleId: spec.invalidRule,
        message: `The ${spec.noun} declares no "${spec.refKey}" list, so there is nothing to compare; declare it, using [] for a ${spec.noun} that deliberately references no scope.`,
      })
      return null
    }
    return { refs: [], pointers: new Map(), refused: 0 }
  }

  if (isPlainObject(raw) && ALTERNATIVE_KEYWORDS.some((keyword) => Object.hasOwn(raw, keyword))) {
    sink.add({
      file,
      pointer: `${pointer}/${spec.refKey}`,
      ruleId: 'requirement-unsupported',
      message: `"${spec.refKey}" uses an alternative-requirement construct (${ALTERNATIVE_KEYWORDS.filter((keyword) => Object.hasOwn(raw, keyword)).join(', ')}), which this build does not evaluate; the ${spec.noun} was not evaluated rather than assumed satisfied.`,
      suggestion: `Express "${spec.refKey}" as a flat array of scope names that must all be held, or evaluate this ${spec.noun} by hand.`,
    })
    return null
  }

  if (!Array.isArray(raw)) {
    sink.add({
      file,
      pointer: `${pointer}/${spec.refKey}`,
      ruleId: spec.invalidRule,
      message: `"${spec.refKey}" must be an array of scope names; this is ${describeValue(raw)}.`,
    })
    return null
  }

  if (raw.length > limits.maxScopeRefs) {
    sink.add({
      file,
      pointer: `${pointer}/${spec.refKey}`,
      ruleId: 'too-many-scope-references',
      message: `"${spec.refKey}" holds ${raw.length} entries, above the maxScopeRefs limit of ${limits.maxScopeRefs}; the ${spec.noun} was refused rather than read in part.`,
      suggestion: 'Raise --max-scope-refs, or split the entry.',
    })
    return null
  }

  const refs = []
  const pointers = new Map()
  const seen = new Set()
  let refused = 0

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index]
    const refPointer = `${pointer}/${spec.refKey}/${index}`

    if (looksLikePattern(candidate)) {
      refused += 1
      sink.add({
        file,
        pointer: refPointer,
        ruleId: 'scope-pattern-unsupported',
        message: `This ${spec.refKey} entry is a pattern, not a scope name; this build expands only declared implications and never guesses which names a pattern covers, so it was refused.`,
        suggestion: 'List the scope names the pattern was meant to stand for.',
      })
      continue
    }

    if (!isIdentifier(candidate)) {
      refused += 1
      sink.add({
        file,
        pointer: refPointer,
        ruleId: 'identifier-invalid',
        message: `This ${spec.refKey} entry is not a usable scope name; it is ${describeValue(candidate)}.`,
        suggestion: 'A scope name is 1-120 characters from [A-Za-z0-9._:/+_-], starting with a letter or digit.',
      })
      continue
    }

    if (seen.has(candidate)) {
      sink.add({
        file,
        pointer: refPointer,
        ruleId: 'scope-reference-duplicate',
        message: `Scope "${excerpt(candidate, 120)}" is listed more than once in "${spec.refKey}"; the repeat adds nothing and was counted once.`,
      })
      continue
    }

    seen.add(candidate)
    pointers.set(candidate, refPointer)
    refs.push(candidate)
  }

  return { refs, pointers, refused }
}

/**
 * Compile one document.
 *
 * Returns `null` when the document as a whole is unusable -- unreadable shape,
 * a version this build does not implement, or more entries than the limit
 * allows. A document that compiles may still have refused entries; `declared`
 * and `entries.length` differ in that case, and the caller treats the gap as
 * missing evidence rather than as a clean result.
 */
export function compileDocument(sink, file, kind, value, limits) {
  const spec = SPECS[kind]

  if (!isPlainObject(value)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} must hold a JSON object with "schemaVersion" and "${spec.listKey}"; it holds ${describeValue(value)}.`,
    })
    return null
  }

  const strayKeys = unknownKeys(value, spec.documentKeys)
  if (strayKeys.length > 0) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} declares unknown key(s) ${strayKeys.map((key) => `"${excerpt(key, 60)}"`).join(', ')}; known keys are ${spec.documentKeys.join(', ')}. An unknown key is refused rather than ignored, so a typo cannot disable a check.`,
    })
    return null
  }

  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      message: `${file} declares schemaVersion ${describeValue(value.schemaVersion)}; this build implements version "${DOCUMENT_SCHEMA_VERSION}" only, and it does not guess at another one.`,
      suggestion: `Re-export the document as schemaVersion "${DOCUMENT_SCHEMA_VERSION}".`,
    })
    return null
  }

  const list = value[spec.listKey]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: 'document-invalid',
      message: `"${spec.listKey}" must be an array; it is ${describeValue(list)}.`,
    })
    return null
  }

  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: spec.limitRule,
      message: `${file} declares ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; nothing was compiled from it rather than a prefix being read and reported as the whole.`,
      suggestion: `Raise --max-${spec.noun}s, or split the document.`,
    })
    return null
  }

  const entries = []
  const byId = new Map()

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    const pointer = `/${spec.listKey}/${index}`

    if (!isPlainObject(raw)) {
      sink.add({
        file,
        pointer,
        ruleId: spec.invalidRule,
        message: `A ${spec.noun} entry must be an object; this is ${describeValue(raw)}.`,
      })
      continue
    }

    const stray = unknownKeys(raw, spec.entryKeys)
    if (stray.length > 0) {
      sink.add({
        file,
        pointer,
        ruleId: spec.invalidRule,
        message: `This ${spec.noun} declares unknown key(s) ${stray.map((key) => `"${excerpt(key, 60)}"`).join(', ')}; known keys are ${spec.entryKeys.join(', ')}. Nothing outside that list is read, which is why no credential or token field can reach this tool by accident.`,
      })
      continue
    }

    if (kind === 'scopes' && looksLikePattern(raw.id)) {
      sink.add({
        file,
        pointer: `${pointer}/id`,
        ruleId: 'scope-pattern-unsupported',
        message: 'This scope is declared as a pattern; this build compares declared names and does not expand patterns, so the entry was refused rather than matched against anything.',
        suggestion: 'Declare each concrete scope name the pattern stands for.',
      })
      continue
    }

    if (!isIdentifier(raw.id)) {
      sink.add({
        file,
        pointer: `${pointer}/id`,
        ruleId: 'identifier-invalid',
        message: `This ${spec.noun} has no usable id; it is ${describeValue(raw.id)}.`,
        suggestion: 'An id is 1-120 characters from [A-Za-z0-9._:/+_-], starting with a letter or digit.',
      })
      continue
    }

    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION_LENGTH)) {
      sink.add({
        file,
        pointer: `${pointer}/description`,
        ruleId: spec.invalidRule,
        message: `"description" must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters; it is ${describeValue(raw.description)}.`,
      })
      continue
    }

    if (byId.has(raw.id)) {
      sink.add({
        file,
        pointer: `${pointer}/id`,
        ruleId: spec.duplicateRule,
        message: `${spec.noun} id "${excerpt(raw.id, 120)}" is declared twice, at ${byId.get(raw.id).pointer} and here; neither copy is authoritative, so this one was refused.`,
      })
      continue
    }

    const references = compileReferences(sink, file, pointer, spec, raw, limits)
    if (references === null) continue

    const entry = {
      index,
      pointer,
      id: raw.id,
      description: raw.description === undefined ? '' : raw.description,
      refs: references.refs,
      refPointers: references.pointers,
      refsRefused: references.refused,
    }
    byId.set(raw.id, entry)
    entries.push(entry)
  }

  return { declared: list.length, entries, byId }
}
