/**
 * The matrix itself: least-required sets, coverage, and grants nothing needs.
 *
 * Three questions are answered here, and each of them has an answer this tool
 * refuses to guess at:
 *
 * - **What does an operation least require?** The smallest subset of its
 *   declared requirement whose declared implications still cover the whole of
 *   it. A scope that is not declared is never dropped from a requirement on the
 *   grounds that some other scope "probably" covers it.
 * - **Which clients cover it?** Those whose effective set -- direct grants plus
 *   declared implications -- contains every required scope. A name the catalog
 *   does not declare contributes nothing to an effective set, so it can never
 *   make an operation look covered.
 * - **Which grants does nothing need?** Those whose removal changes nothing the
 *   client can do, which is a statement about this matrix and not about the
 *   provider.
 *
 * Every answer here is relative to the three documents that were read. The
 * README says so in its own words, and so does every message that could be
 * mistaken for a stronger claim.
 */

import { closureOf } from './implication.mjs'
import { byCodeUnit, excerpt } from './text.mjs'

/**
 * Ordering is written out at every place that orders something, and never
 * routed through one shared helper.
 *
 * A helper would leave a single line for a mutation to change, and pinning that
 * one line pins nothing about the twelve places that call it: each of them can
 * be swapped on its own. Spelled out at the site, each order is a separate
 * thing to get wrong and a separate thing for `test/ordering.test.mjs` to pin
 * by what the tool emits.
 */

/**
 * The smallest subset of `required` whose closure still covers `required`.
 *
 * Scopes are considered for removal in code-unit order, and the order matters:
 * when two required scopes imply each other, either one alone would do, and
 * which one survives is decided by that order. Collation would pick the other
 * one on a machine with different ICU data, so the same matrix would report a
 * different least-required set depending on where it ran.
 */
function leastRequiredSet(graph, required) {
  const keep = new Set(required)
  for (const candidate of [...required].sort(byCodeUnit)) {
    if (keep.size === 1) break
    const trial = new Set(keep)
    trial.delete(candidate)
    const effective = closureOf(graph, trial)
    if (required.every((scope) => effective.has(scope))) keep.delete(candidate)
  }
  return keep
}

/** Which kept scope covers a dropped one; the first by code unit, so the message is stable. */
function impliedBy(graph, keep, scope) {
  for (const held of [...keep].sort(byCodeUnit)) {
    if (graph.reach.get(held)?.has(scope)) return held
  }
  return null
}

/**
 * Compile the operations into requirement rows.
 *
 * An operation whose requirement names a scope the catalog does not declare is
 * not evaluated at all. Reporting it as uncovered would be a verdict drawn from
 * evidence nobody has: the name might be an alias for something granted, or a
 * typo, or a scope somebody forgot to export. Reporting it as covered would be
 * worse. It is counted as unevaluated, and the run says so.
 */
function buildOperations(sink, file, operations, byScope, graph, budget) {
  const rows = []

  for (const operation of operations) {
    budget.check()
    const unknown = []
    for (const scope of operation.refs) {
      if (byScope.has(scope)) continue
      unknown.push(scope)
      sink.add({
        file,
        pointer: operation.refPointers.get(scope),
        ruleId: 'requirement-scope-unknown',
        message: `Operation "${excerpt(operation.id, 120)}" requires "${excerpt(scope, 120)}", which the scope catalog does not declare; coverage for this operation was not decided, because an undeclared scope is unknown and an unknown scope is never treated as held.`,
        suggestion: 'Export the scope definition, or correct the requirement.',
      })
    }

    if (unknown.length > 0) {
      rows.push({
        id: operation.id,
        pointer: operation.pointer,
        description: operation.description,
        required: operation.refs,
        least: null,
        coveredBy: [],
        status: 'unevaluated',
      })
      continue
    }

    if (operation.refs.length === 0) {
      sink.add({
        file,
        pointer: `${operation.pointer}/requires`,
        ruleId: 'operation-requires-nothing',
        message: `Operation "${excerpt(operation.id, 120)}" requires no scope at all, so every client covers it, including one that holds nothing; this tool cannot tell a deliberately public operation from a requirement somebody forgot to write down.`,
        suggestion: 'Confirm the operation is meant to be reachable without any scope.',
      })
    }

    const keep = leastRequiredSet(graph, operation.refs)
    // Declared order, deliberately unsorted: each dropped scope gets its own
    // finding and all of them land on the same pointer, so the order they are
    // emitted in is discarded by the report's own sort. A sort here would be a
    // sort whose result nothing can observe, which is a sort no test can pin.
    for (const scope of operation.refs) {
      if (keep.has(scope)) continue
      const cover = impliedBy(graph, keep, scope)
      sink.add({
        file,
        pointer: `${operation.pointer}/requires`,
        ruleId: 'requirement-redundant',
        message: `Operation "${excerpt(operation.id, 120)}" requires "${excerpt(scope, 120)}", which "${excerpt(cover ?? '', 120)}" already implies; the least-required set is smaller than the requirement as written.`,
      })
    }

    rows.push({
      id: operation.id,
      pointer: operation.pointer,
      description: operation.description,
      required: operation.refs,
      least: keep,
      coveredBy: [],
      status: 'evaluated',
    })
  }

  return rows
}

/**
 * Compile the clients into grant rows.
 *
 * A granted name the catalog does not declare is reported and then left out of
 * the effective set. That makes every coverage answer for that client a floor
 * rather than an answer -- the client may really hold more than this tool can
 * see -- which is exactly why the run is incomplete and never a pass.
 */
function buildClients(sink, file, clients, byScope, graph, budget) {
  const rows = []

  for (const client of clients) {
    budget.check()
    const granted = []
    for (const scope of client.refs) {
      if (byScope.has(scope)) {
        granted.push(scope)
        continue
      }
      sink.add({
        file,
        pointer: client.refPointers.get(scope),
        ruleId: 'grant-scope-unknown',
        message: `Client "${excerpt(client.id, 120)}" is granted "${excerpt(scope, 120)}", which the scope catalog does not declare; it was not treated as held and nothing was assumed about what it would allow.`,
        suggestion: 'Export the scope definition, or revoke a grant nobody can describe.',
      })
    }

    if (client.refs.length === 0) {
      sink.add({
        file,
        pointer: `${client.pointer}/scopes`,
        ruleId: 'client-grants-nothing',
        message: `Client "${excerpt(client.id, 120)}" is granted no scope, so it covers only operations that require none.`,
      })
    }

    rows.push({
      id: client.id,
      pointer: client.pointer,
      description: client.description,
      declared: client.refs,
      pointers: client.refPointers,
      granted,
      effective: closureOf(graph, granted),
      covers: [],
      extra: [],
    })
  }

  return rows
}

/**
 * Grants this matrix does not need, in two distinguishable shapes.
 *
 * `grant-implied-by-another` means the client keeps the scope either way --
 * another grant confers it. `grant-unused` means nothing in the matrix asks for
 * it. They are reported separately because the fix differs: the first is a
 * tidy-up, the second is a permission to consider revoking. Where both apply
 * only the first is reported, because "remove it, you already have it" is the
 * accurate advice and "nothing needs it" would be misleading.
 */
function reportExtraGrants(sink, file, client, graph, requiredByCovered) {
  /**
   * First, the grants another grant already confers.
   *
   * Within a group of mutually implying scopes every member confers every
   * other, so flagging all of them would advise removing the lot and leaving
   * the client with none. The first by code unit is kept and the rest are
   * reported against it.
   */
  const implied = new Set()
  for (const scope of client.granted) {
    const candidates = client.granted.filter((other) => {
      if (other === scope) return false
      if (!graph.reach.get(other)?.has(scope)) return false
      const mutual = graph.reach.get(scope)?.has(other) === true
      return !(mutual && byCodeUnit(scope, other) < 0)
    })
    if (candidates.length === 0) continue

    const source = [...candidates].sort(byCodeUnit)[0]
    implied.add(scope)
    client.extra.push(scope)
    sink.add({
      file,
      pointer: client.pointers.get(scope),
      ruleId: 'grant-implied-by-another',
      message: `Client "${excerpt(client.id, 120)}" is granted "${excerpt(scope, 120)}" and also "${excerpt(source, 120)}", which already implies it; listing both changes nothing this client can do.`,
    })
  }

  /**
   * Then, of the grants that are left, the ones nothing asks for.
   *
   * The provider count is taken over the *kept* grants only. Counting the
   * implied ones too would make each member of a mutually implying pair look
   * as though the other one covered for it, and the surviving member would then
   * be reported as spare as well -- so the report would advise revoking a
   * permission the client actually needs.
   */
  const kept = client.granted.filter((scope) => !implied.has(scope))
  const providers = new Map()
  for (const scope of kept) {
    for (const held of closureOf(graph, [scope])) {
      providers.set(held, (providers.get(held) ?? 0) + 1)
    }
  }

  for (const scope of kept) {
    const uniqueToThisGrant = [...closureOf(graph, [scope])].filter((held) => providers.get(held) === 1)
    if (uniqueToThisGrant.some((held) => requiredByCovered.has(held))) continue

    client.extra.push(scope)
    sink.add({
      file,
      pointer: client.pointers.get(scope),
      ruleId: 'grant-unused',
      message: `Client "${excerpt(client.id, 120)}" is granted "${excerpt(scope, 120)}", which no operation it covers requires; removing it would change nothing in this matrix.`,
      evidence: client.description === '' ? undefined : `client: ${excerpt(client.description, 100)}`,
      suggestion: 'Confirm the grant is needed by something outside this matrix, or revoke it.',
    })
  }
}

/**
 * Compare the three documents and report what they say about one another.
 *
 * Every count returned here is a count of things that were actually evaluated.
 * Nothing is counted as checked because it was read.
 */
export function buildMatrix(sink, files, scopes, clients, operations, graph, budget) {
  const byScope = scopes.byId
  const operationRows = buildOperations(sink, files.operations, operations.entries, byScope, graph, budget)
  const clientRows = buildClients(sink, files.clients, clients.entries, byScope, graph, budget)

  let covered = 0
  let uncovered = 0
  let unevaluated = 0

  for (const row of operationRows) {
    budget.check()
    if (row.status === 'unevaluated') {
      unevaluated += 1
      continue
    }

    const coveringClients = []
    for (const client of clientRows) {
      if (row.required.every((scope) => client.effective.has(scope))) {
        coveringClients.push(client.id)
        client.covers.push(row.id)
      }
    }
    row.coveredBy = coveringClients

    if (coveringClients.length > 0) {
      covered += 1
      continue
    }

    uncovered += 1
    let closest = null
    for (const client of clientRows) {
      const missing = row.required.filter((scope) => !client.effective.has(scope))
      if (closest === null || missing.length < closest.missing.length) closest = { client, missing }
      // A tie is broken by client id in code-unit order, so the named client is
      // the same on every machine rather than the same as the document order.
      else if (missing.length === closest.missing.length && byCodeUnit(client.id, closest.client.id) < 0) {
        closest = { client, missing }
      }
    }

    sink.add({
      file: files.operations,
      pointer: `${row.pointer}/requires`,
      ruleId: 'operation-uncovered',
      message: `No client in this matrix covers operation "${excerpt(row.id, 120)}"; it requires ${[...row.required].sort(byCodeUnit).map((scope) => `"${excerpt(scope, 60)}"`).join(', ') || 'nothing'}.`,
      evidence: closest === null
        ? `no client declared; required: ${[...row.required].sort(byCodeUnit).join(', ')}`
        : `closest client "${excerpt(closest.client.id, 60)}" is missing: ${[...closest.missing].sort(byCodeUnit).join(', ')}`,
      suggestion: 'Grant the missing scopes to a client, or retire the operation.',
    })
  }

  const requiredAnywhere = new Set()
  for (const row of operationRows) for (const scope of row.required) requiredAnywhere.add(scope)

  for (const client of clientRows) {
    budget.check()
    const requiredByCovered = new Set()
    for (const row of operationRows) {
      if (row.status !== 'evaluated') continue
      if (!client.covers.includes(row.id)) continue
      for (const scope of row.required) requiredByCovered.add(scope)
    }
    reportExtraGrants(sink, files.clients, client, graph, requiredByCovered)
  }

  const grantedAnywhere = new Set()
  for (const client of clientRows) for (const scope of client.declared) grantedAnywhere.add(scope)

  for (const scope of scopes.entries) {
    if (requiredAnywhere.has(scope.id) || grantedAnywhere.has(scope.id)) continue
    sink.add({
      file: files.scopes,
      pointer: scope.pointer,
      ruleId: 'scope-unused',
      message: `Scope "${excerpt(scope.id, 120)}" is exported but no client is granted it and no operation requires it; within these three documents it does nothing.`,
      evidence: scope.description === '' ? undefined : `scope: ${excerpt(scope.description, 100)}`,
    })
  }

  if (scopes.entries.length === 0) {
    sink.add({
      file: files.scopes,
      pointer: '/scopes',
      ruleId: 'no-scopes',
      message: 'The scope catalog declares no scope, so there is nothing for a grant or a requirement to name.',
      suggestion: 'Export the provider scope definitions before comparing anything against them.',
    })
  }

  if (clients.entries.length === 0) {
    sink.add({
      file: files.clients,
      pointer: '/clients',
      ruleId: 'no-clients',
      message: 'No client is declared, so no operation in this matrix is covered by anything.',
      suggestion: 'Export at least one client grant.',
    })
  }

  const extraGrants = clientRows.reduce((total, client) => total + client.extra.length, 0)

  return {
    checked: covered + uncovered,
    covered,
    uncovered,
    unevaluated,
    extraGrants,
    matrix: {
      scopes: scopes.entries.map((scope) => scope.id).sort(byCodeUnit),
      operations: operationRows
        .map((row) => ({
          id: row.id,
          requires: [...row.required].sort(byCodeUnit),
          leastRequired: row.least === null ? null : [...row.least].sort(byCodeUnit),
          coveredBy: [...row.coveredBy].sort(byCodeUnit),
          status: row.status === 'unevaluated' ? 'unevaluated' : row.coveredBy.length > 0 ? 'covered' : 'uncovered',
        }))
        .sort((left, right) => byCodeUnit(left.id, right.id)),
      clients: clientRows
        .map((client) => ({
          id: client.id,
          granted: [...client.granted].sort(byCodeUnit),
          effective: [...client.effective].sort(byCodeUnit),
          covers: [...client.covers].sort(byCodeUnit),
          extra: [...client.extra].sort(byCodeUnit),
        }))
        .sort((left, right) => byCodeUnit(left.id, right.id)),
    },
  }
}
