# Rule catalog, limits and the supported dialect

`oauth-scope-matrix` reads three documents and reports what they say about one
another. It requests no token, reads no token and opens no socket. Everything
below is a statement about those three documents and nothing else.

## Input dialect

All three documents are JSON objects with `"schemaVersion": "1"` and one array.
Any other version is reported as unsupported and the document is not read: this
build does not guess at a shape it does not implement.

```json
// scopes.json
{ "schemaVersion": "1", "scopes": [
  { "id": "catalog.read", "description": "Read catalog entries." },
  { "id": "catalog.write", "description": "Edit catalog entries.", "implies": ["catalog.read"] }
] }

// clients.json
{ "schemaVersion": "1", "clients": [
  { "id": "backoffice", "description": "Internal desk.", "scopes": ["catalog.write"] }
] }

// operations.json
{ "schemaVersion": "1", "operations": [
  { "id": "list-catalog", "description": "GET /catalog", "requires": ["catalog.read"] }
] }
```

Keys are exhaustive. An unknown key anywhere is refused rather than ignored, so
a one-character typo cannot disable a check — and so no field named `token`,
`accessToken`, `clientSecret` or anything similar can be read into this tool by
accident.

An `id` is 1–120 characters from `[A-Za-z0-9._:/+_-]`, starting with a letter or
digit. A `description` is at most 300 characters.

### What is supported, and what is refused as unsupported

| Construct | Status |
| --- | --- |
| `implies` / `scopes` / `requires` as a flat array of scope names | supported; a `requires` array is a conjunction — every name must be held |
| a declared implication graph, including cycles | supported; walked with a visited set |
| a wildcard or templated scope (`repo:*`, `projects/{id}/read`) | **refused as unsupported**; never expanded, never matched |
| `requires` as `{"anyOf": …}`, `oneOf`, `allOf`, `not`, `if` | **refused as unsupported**; the operation is not evaluated |
| a scope name the catalog does not declare | **unknown**; never treated as held |
| OpenAPI, JSON Schema, or a provider's own export format | not read; convert to the three documents above |

An unsupported construct makes the run `incomplete`. It is never silently
treated as satisfied. That distinction is the whole reason this package
implements its own bounded reader instead of pulling in a general validator and
then disclaiming the parts of it that do not apply.

### Implication is declared, never inferred

`repo:write` does not imply `repo:read` because one name is a prefix of the
other. Nothing about the spelling of a scope tells you what it confers:
Google's `drive.file` does not confer `drive.readonly`, Microsoft's
`Files.ReadWrite` is not the same grant as `Files.Read.All`, and `admin:org`
says nothing at all about `repo`. Only the `implies` list creates an edge.

## Rule catalog

Severity is taken from one frozen table in `src/index.mjs`. This catalog is
asserted against that table in both directions by `test/severity-table.test.mjs`.
Because a table and a catalog are two declarations that one edit can change
together, the severity that decides pass or fail is *also* pinned behaviourally:
`test/severity-exit.test.mjs` pins the process exit code, and
`test/severity-word.test.mjs` pins the error count and the printed severity word
with literal values, sharing no table with anything else.

### Input and document

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable` | `error` | A document could not be reached, inspected or read. |
| `input-not-utf8` | `error` | A document is not valid UTF-8. Decoding is strict; validity is never inferred from decoded text. |
| `input-not-json` | `error` | A document is not valid JSON. |
| `input-too-large` | `error` | A document is larger than `maxFileBytes` and was not read. |
| `path-escapes-root` | `error` | A document resolves outside `--root` and was refused unread. |
| `document-invalid` | `error` | A document is not an object, declares an unknown key, or its list is not an array. |
| `schema-version-unsupported` | `error` | A document declares a `schemaVersion` this build does not implement. |

### Entries

| Rule | Severity | Meaning |
| --- | --- | --- |
| `scope-invalid` | `error` | A scope entry is malformed or declares an unknown key. |
| `client-invalid` | `error` | A client entry is malformed, declares an unknown key, or has no `scopes` list. |
| `operation-invalid` | `error` | An operation entry is malformed, declares an unknown key, or has no `requires` list. |
| `identifier-invalid` | `error` | An id or a scope name is not a usable identifier. The refused value is described, never reproduced. |
| `scope-duplicate` | `error` | A scope id is declared twice; neither copy is authoritative. |
| `client-duplicate` | `error` | A client id is declared twice. |
| `operation-duplicate` | `error` | An operation id is declared twice. |
| `scope-reference-duplicate` | `error` | A scope name is listed twice in one `implies`, `scopes` or `requires` list. |
| `scope-pattern-unsupported` | `error` | A scope is written as a pattern. It is never expanded and never matched. |
| `requirement-unsupported` | `error` | A `requires` uses an alternative construct this build does not evaluate. |

### Implication graph

| Rule | Severity | Meaning |
| --- | --- | --- |
| `scope-implication-unknown` | `error` | A scope implies a name the catalog does not declare. The edge is not followed. |
| `implication-depth-exceeded` | `error` | An implication chain is deeper than `maxImplicationDepth`; the effective set below it is a floor. |
| `scope-implication-self` | `warning` | A scope implies itself. The edge carries no information and was dropped. |
| `scope-implication-cycle` | `warning` | A group of scopes imply one another, so each confers all of them. |

### The matrix

| Rule | Severity | Meaning |
| --- | --- | --- |
| `grant-scope-unknown` | `error` | A client is granted a name the catalog does not declare. It is **not** treated as held. |
| `requirement-scope-unknown` | `error` | An operation requires a name the catalog does not declare. Coverage is not decided. |
| `operation-uncovered` | `error` | No client's effective set covers an operation's requirement. |
| `no-scopes` | `error` | The scope catalog declares nothing for a grant or a requirement to name. |
| `no-clients` | `error` | No client is declared, so nothing in the matrix is covered. |
| `no-operations-evaluated` | `error` | Nothing was evaluated, so the run has no evidence to be green on. |
| `requirement-redundant` | `warning` | A required scope is already implied by another required scope. |
| `operation-requires-nothing` | `warning` | An operation requires no scope, so every client covers it. |
| `client-grants-nothing` | `warning` | A client is granted no scope. |
| `grant-implied-by-another` | `warning` | A granted scope is already conferred by another grant of the same client. |
| `grant-unused` | `warning` | A granted scope is needed by no operation this client covers. |
| `scope-unused` | `info` | A declared scope is neither granted nor required anywhere in this matrix. |

### Bounds

| Rule | Severity | Meaning |
| --- | --- | --- |
| `too-many-scopes` | `error` | The scope catalog declares more entries than `maxScopes`; nothing was compiled from it. |
| `too-many-clients` | `error` | More clients than `maxClients`; nothing was compiled from that document. |
| `too-many-operations` | `error` | More operations than `maxOperations`; nothing was compiled from that document. |
| `too-many-scope-references` | `error` | One reference list is longer than `maxScopeRefs`; the entry was refused rather than read in part. |
| `too-many-findings` | `error` | The report reached `maxFindings` and is partial. |
| `time-budget-exceeded` | `error` | The comparison passed `maxRuntimeMs` and stopped; the matrix is partial. |

## Limits

| Limit | Default | Hard cap | CLI flag |
| --- | ---: | ---: | --- |
| `maxFileBytes` | 5242880 | 67108864 | `--max-file-bytes` |
| `maxScopes` | 500 | 5000 | `--max-scopes` |
| `maxClients` | 200 | 2000 | `--max-clients` |
| `maxOperations` | 1000 | 20000 | `--max-operations` |
| `maxScopeRefs` | 50 | 500 | `--max-scope-refs` |
| `maxImplicationDepth` | 16 | 64 | `--max-implication-depth` |
| `maxRuntimeMs` | 10000 | 600000 | `--max-runtime-ms` |
| `maxFindings` | 1000 | 20000 | `--max-findings` |

A limit may be lowered, never raised past its hard cap. An unknown limit key is
a configuration error, not something to ignore. Exceeding a limit always
produces a finding that names it and makes the run `incomplete`; it is never a
silent truncation.

The time budget reads a monotonic timer. It is the one input to this package
that is not a file, and it is injectable (`clock`) so that the tests drive it
without waiting and so that nothing here reads a wall clock.

## Status, exit codes and ordering

| Status | Exit | When |
| --- | ---: | --- |
| `pass` | 0 | The matrix was compared and no error-severity rule fired. |
| `fail` | 1 | The matrix was compared and at least one error-severity rule fired. |
| `incomplete` | 2 | Evidence was missing, unsupported or truncated. Never a pass. |

A configuration error — an unknown flag, a bad limit, a file name outside the
root — exits 2 with **empty stdout**, because the run never had a subject to
report about.

Findings are ordered by `location.file`, then `location.pointer`, then `ruleId`,
then `message`, all by UTF-16 code unit. Nothing in this package uses
locale-aware comparison. `test/ordering.test.mjs` pins twenty-four of the
twenty-seven ordering sites against inputs an English collator orders
differently; `test/ordering-equivalence.test.mjs` proves the remaining three
equivalent by enumerating every ordered pair of their real values.

## How the two guards were measured

Both guards are the kind that look like coverage while defending nothing, so
both were measured by breaking the code and watching the suite.

**Ordering.** Each of the twenty-seven `byCodeUnit` call sites in `src/` was
swapped, one at a time, to `new Intl.Collator('en').compare`, and the full suite
was run against each mutant. **24 of 27 were caught.** The three that survive are
the ones `test/ordering-equivalence.test.mjs` proves equivalent: the known-limits
list in a configuration error, and the `location.pointer` and `ruleId` components
of the finding comparator. Their real values collate exactly as they compare by
code unit, so no output can change and no test could catch them.

Which comparator those two components use is therefore undecidable from the
output; *where they sit in the sort key* is not, and both places are pinned by
cases that emit findings whose keys disagree -- two findings in one file at
different pointers whose rule ids run the other way round, and two at one
pointer under one rule whose messages do.

**Severity.** Each of the thirty-one error rules was demoted to `warning` by the
coordinated edit -- the frozen table in `src/index.mjs` *and* the catalog above,
which is every declaration of severity this package has. **31 of 31 were caught,
0 survived.** Running the flip in the other direction, promoting each of the
seven warning rules and the one info rule to `error`, caught all 8. The tests
that catch them assert exit codes, error counts and printed severity words with
literal values; none of them reads a table.

## What the matrix does not establish

See the "Limits and non-goals" section of `README.md`. In short: a pass says the
three documents are consistent with one another. It says nothing about what the
provider enforces, nothing about what a token actually carries, and nothing
about any scope, client or operation that was not exported into these files.
