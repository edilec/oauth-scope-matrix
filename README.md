# oauth-scope-matrix

Compare exported OAuth scope definitions, client grants and operation
requirements. Reports the **least-required set** for each operation, the
operations **no grant covers**, and the grants **nothing requires**.

No token is ever requested or read. No socket is ever opened. The three
documents you give it are the only evidence there is, and every conclusion in
the report is a conclusion about those three documents.

- **Repository:** [edilec/oauth-scope-matrix](https://github.com/edilec/oauth-scope-matrix)
- **Area:** API & Integration
- **License:** MIT
- Node >= 22, ESM, **zero dependencies** — runtime and development alike.

## Install and run

```sh
npx oauth-scope-matrix --root ./oauth
```

`--root` holds three files. Their names default to `scopes.json`,
`clients.json` and `operations.json` and can be given explicitly with
`--scopes`, `--clients` and `--operations`.

```sh
oauth-scope-matrix --root ./oauth --json | jq '.matrix.operations[] | select(.status == "uncovered")'
```

`stdout` carries the JSON report and nothing else, so it pipes straight into a
parser. `stderr` carries the human summary and the diagnostics — **a non-empty
stderr is correct**, not an error.

## Input

```json
// scopes.json — what the provider exports, and what implies what
{ "schemaVersion": "1", "scopes": [
  { "id": "catalog.read",  "description": "Read catalog entries." },
  { "id": "catalog.write", "description": "Edit catalog entries.", "implies": ["catalog.read"] }
] }

// clients.json — what each client is actually granted
{ "schemaVersion": "1", "clients": [
  { "id": "backoffice", "scopes": ["catalog.write"] }
] }

// operations.json — what each operation needs
{ "schemaVersion": "1", "operations": [
  { "id": "list-catalog",        "requires": ["catalog.read"] },
  { "id": "update-catalog-item", "requires": ["catalog.write"] }
] }
```

Keys are exhaustive: an unknown key anywhere is refused rather than ignored, so
a one-character typo cannot turn a real failure green — and no field named
`token`, `accessToken` or `clientSecret` can be read into this tool by accident.

### Implication is declared, never inferred

`repo:write` does **not** imply `repo:read` because one name is a prefix of the
other. Nothing about the spelling of a scope tells you what it confers: Google's
`drive.file` does not confer `drive.readonly`, Microsoft's `Files.ReadWrite` is
not the same grant as `Files.Read.All`, and `admin:org` says nothing at all
about `repo`. Only an `implies` list creates an edge, the graph is walked with a
visited set so a declared cycle terminates, and a scope that is neither declared
nor implied is **unknown**.

An unknown scope is never treated as held. It does not enter a client's
effective set, it cannot make an operation look covered, and the run that
contains one is `incomplete` — never a pass.

## Output

```json
{
  "schemaVersion": "1",
  "tool": "oauth-scope-matrix",
  "status": "fail",
  "summary": { "checked": 3, "errors": 2, "warnings": 1, "scopes": 3, "clients": 2,
               "operations": 3, "covered": 2, "uncovered": 1, "unevaluated": 0, "extraGrants": 0 },
  "matrix": {
    "scopes": ["catalog.read", "catalog.write", "reports.read"],
    "operations": [{ "id": "update-catalog-item", "requires": ["catalog.read", "catalog.write"],
                     "leastRequired": ["catalog.write"], "coveredBy": [], "status": "uncovered" }],
    "clients":    [{ "id": "analytics", "granted": ["reports.read"], "effective": ["reports.read"],
                     "covers": ["list-reports"], "extra": [] }]
  },
  "findings": [ { "ruleId": "operation-uncovered", "severity": "error", "message": "…",
                  "location": { "file": "operations.json", "pointer": "/operations/1/requires" } } ]
}
```

| Exit | Status | Meaning |
| ---: | --- | --- |
| 0 | `pass` | The matrix was compared and no error-severity rule fired. |
| 1 | `fail` | The matrix was compared and at least one error-severity rule fired. |
| 2 | `incomplete` | Evidence was missing, unsupported or truncated. |
| 2 | *(no report)* | Invalid configuration. **stdout is empty** — the run never had a subject. |

The rule catalog, the limits and the supported input dialect are in
[`docs/scope-matrix-rules.md`](./docs/scope-matrix-rules.md).

## Examples

| Directory | Result |
| --- | --- |
| `examples/clean` | exits 0 — nothing to report |
| `examples/broken` | exits 1 — an uncovered operation, a redundant requirement, a repeated grant |
| `examples/incomplete` | exits 2 — an undeclared granted scope and an undeclared required scope |

```sh
npm run example            # examples/clean, exits 0
node bin/oauth-scope-matrix.mjs --root examples/broken; echo $?   # 1
node bin/oauth-scope-matrix.mjs --root examples/incomplete; echo $?   # 2
```

## Limits and non-goals

**What a pass means.** The three documents are consistent with one another:
every operation is covered by at least one client, and every scope named is one
the catalog declares. That is the whole claim.

A grant this matrix does not need does **not** withhold the pass. `grant-unused`
and `grant-implied-by-another` are warnings, they are counted in
`summary.extraGrants`, and a run whose only findings are those still exits 0 —
deliberately, because a spare grant may be needed by something outside these
three documents, so the finding asks you to confirm rather than revoke. Read
`summary.extraGrants` if you want a build that refuses them; the exit code will
not do it for you.

**What this tool cannot conclude.**

- **It cannot tell you what the provider enforces.** It compares exports. If
  your `scopes.json` says `catalog.write` implies `catalog.read` and the
  provider disagrees, this tool will agree with your file and be wrong. The
  implication graph is a model somebody wrote down, not an observation.
- **It cannot tell you what a token actually carries.** No token is requested,
  read, decoded or introspected. A client's grant here is what the export says
  it is; a token issued in production may carry more or less.
- **It cannot see anything that was not exported.** An operation missing from
  `operations.json` is not reported as unprotected — it is simply absent. A
  green run over an empty or partial export proves nothing about the parts
  nobody exported, which is why `checked: 0` is refused as a finding rather
  than reported as a pass.
- **It cannot expand a pattern.** `repo:*`, `admin.*` and `projects/{id}/read`
  are recognised as patterns and refused. Guessing which concrete names a
  pattern covers is precisely the inference that makes a scope audit wrong.
- **It does not evaluate alternative requirements.** A `requires` written as
  `{"anyOf": […]}` is reported as unsupported and the operation is not
  evaluated. It is never treated as satisfied.
- **It does not read OpenAPI, JSON Schema, or any provider's own export
  format.** It reads the three documents above. Converting your export into
  them is your step, and it is the step where you decide what the model is.
- **"Uncovered" is relative to the clients you exported**, and "unused" is
  relative to the operations you exported. A grant this tool calls spare may be
  needed by something outside the matrix; the finding says so and suggests you
  confirm rather than revoke.
- **It is not a penetration test, an access review, or evidence of compliance.**
  It is a consistency check over three files, run locally, with no network.

**Determinism.** Findings are ordered by `location.file`, `location.pointer`,
`ruleId` and `message`, all by UTF-16 code unit. Nothing here uses
locale-aware comparison, a wall clock, a random source or filesystem
enumeration order. Two runs over identical inputs produce byte-identical
stdout.

**Safety.** Every input is decoded with a strict UTF-8 decoder — the three
documents alike, with no exception for the one a reviewer thinks of as
configuration. Both sides of a path are resolved to their real paths before
being compared, so a symlink planted inside the root is refused and a
legitimate file under a symlinked root is not. Control, C1, separator and bidi
characters are stripped from every untrusted string that reaches output — ids,
keys, paths, messages and evidence alike. The tool opens files for reading and
writes nothing at all.

## Development

```sh
npm run check      # lint, test, example, pack:check
npm run test:coverage
```

There are no dependencies to install.

## License

MIT. See [LICENSE](./LICENSE).
