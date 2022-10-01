# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Rule ids are
part of the public surface: renaming one is a breaking change and is recorded
here.

## [Unreleased]

### Added

- First implementation of `oauth-scope-matrix`: compares a scope catalog,
  client grants and operation requirements, and reports the least-required set
  per operation, the operations no grant covers, and the grants nothing
  requires.
- A declared implication graph. Implication is read from `implies` lists only
  and never inferred from the shape of a scope name; the walk carries a visited
  set so a declared cycle terminates and is reported instead of hanging.
- Unknown scopes as a first-class outcome: a name that is neither declared nor
  implied is never treated as held, and the run that contains one is
  `incomplete` rather than a pass.
- A bounded input dialect that is declared rather than approximated. Wildcard
  and templated scopes, and alternative-requirement constructs (`anyOf`,
  `oneOf`, `allOf`, `not`, `if`), are reported as unsupported and are never
  silently treated as satisfied.
- A 39-rule catalog with one frozen `ruleId -> severity` table, documented in
  `docs/scope-matrix-rules.md` and pinned behaviourally by exit code, error
  count and printed severity word.
- Enforced limits on bytes, scopes, clients, operations, references per list,
  implication depth, findings and runtime, each reported by name when reached
  and each making the run `incomplete` rather than truncating silently.
- A CLI with `--help`, `--json`, explicit input paths and the three documented
  exit codes; the JSON report on stdout alone.
- Examples for a clean, a failing and an incomplete matrix.

### Security

- No network access of any kind: no token is requested, read, decoded or
  introspected, and no socket is opened. Proved by a module-resolution guard
  that refuses every network builtin, and by a live loopback listener whose
  address is planted in the input and never contacted.
- Read-only: the tool opens files for reading and writes nothing.
- Path confinement resolves the real path of both the root and each input, so a
  symlink planted inside the root is refused while a legitimate file under a
  symlinked root is not.
- Strict UTF-8 decoding on every input, the scope catalog included.
- Control (C0), DEL, C1, line/paragraph separator and bidi characters are
  stripped from every untrusted string that reaches output, identifiers and
  object keys included.

No release has been published.
