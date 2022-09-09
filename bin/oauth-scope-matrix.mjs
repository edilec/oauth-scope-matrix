#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_CLIENTS_NAME,
  DEFAULT_OPERATIONS_NAME,
  DEFAULT_SCOPES_NAME,
  auditScopeMatrix,
  excerpt,
  exitCodeFor,
  formatReport,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `oauth-scope-matrix

Compare exported scope definitions, client grants and operation requirements.
Reports the least-required set for each operation, the operations no grant
covers, and the grants nothing requires. No token is ever requested or read and
no socket is ever opened: the three documents are the only evidence there is.

Usage:
  oauth-scope-matrix --root DIR [--scopes FILE] [--clients FILE]
                     [--operations FILE] [--json]
                     [--max-file-bytes N] [--max-scopes N] [--max-clients N]
                     [--max-operations N] [--max-scope-refs N]
                     [--max-implication-depth N] [--max-runtime-ms N]
                     [--max-findings N]

Options:
  --root DIR                 Directory holding the three documents (required)
  --scopes FILE              Scope catalog, relative to --root
                             (default ${DEFAULT_SCOPES_NAME})
  --clients FILE             Client grants, relative to --root
                             (default ${DEFAULT_CLIENTS_NAME})
  --operations FILE          Operation requirements, relative to --root
                             (default ${DEFAULT_OPERATIONS_NAME})
  --json                     Suppress the human summary on stderr
  --max-file-bytes N         Maximum bytes per document (default 5242880)
  --max-scopes N             Maximum declared scopes (default 500)
  --max-clients N            Maximum declared clients (default 200)
  --max-operations N         Maximum declared operations (default 1000)
  --max-scope-refs N         Maximum scope names in one list (default 50)
  --max-implication-depth N  Maximum implication hops walked (default 16)
  --max-runtime-ms N         Time budget for the comparison (default 10000)
  --max-findings N           Maximum findings in one report (default 1000)
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  The three documents agree with one another: every operation is covered by at
  least one client, every scope named is one the catalog declares, and nothing
  is granted that this matrix does not need. It is not a statement about the
  provider. Implication is read from the "implies" lists and from nowhere else,
  so a pass says the declared model is consistent, never that the declared model
  matches what the provider actually enforces.

Exit codes:
  0  the matrix was compared and nothing contradicted it
  1  the matrix was compared and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-clients', 'maxClients'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-implication-depth', 'maxImplicationDepth'],
  ['--max-operations', 'maxOperations'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
  ['--max-scope-refs', 'maxScopeRefs'],
  ['--max-scopes', 'maxScopes'],
])

const VALUE_FLAGS = new Map([
  ['--clients', 'clients'],
  ['--operations', 'operations'],
  ['--root', 'root'],
  ['--scopes', 'scopes'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, scopes: null, clients: null, operations: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--clients a.json --clients b.json` compares a file nobody named and
   * `--max-scopes 5 --max-scopes 5000` enforces a bound nobody asked for. That
   * is the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await auditScopeMatrix({
      root: options.root,
      limits: options.limits,
      ...(options.scopes === null ? {} : { scopes: options.scopes }),
      ...(options.clients === null ? {} : { clients: options.clients }),
      ...(options.operations === null ? {} : { operations: options.operations }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and the
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      scopes: options.scopes ?? DEFAULT_SCOPES_NAME,
      clients: options.clients ?? DEFAULT_CLIENTS_NAME,
      operations: options.operations ?? DEFAULT_OPERATIONS_NAME,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.operations} declared operation(s) were evaluated; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
