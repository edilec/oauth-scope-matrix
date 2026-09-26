/**
 * The declared implication graph.
 *
 * Implication is read from the `implies` list and from nowhere else. This tool
 * never infers that `repo:write` implies `repo:read` because one string is a
 * prefix, a suffix or a "higher tier" of the other -- that guess is wrong for
 * real providers (Google's `drive.readonly` is not implied by `drive.file`;
 * GitHub's `repo` does imply `repo:status` but `admin:org` implies nothing
 * about `repo`), and a wrong guess here is a permission the report says a
 * client has when it does not.
 *
 * Everything below walks edges that somebody declared, with a visited set, so a
 * declaration that loops back on itself terminates instead of running forever.
 */

import { byCodeUnit, excerpt } from './text.mjs'

/**
 * Build the graph, reporting every edge that cannot be followed.
 *
 * An edge to a scope the catalog does not declare is dropped and reported. It
 * is emphatically not followed "just in case" and it is not treated as if the
 * target were held: an unknown scope is unknown, and the run that contains one
 * is incomplete rather than green.
 */
export function buildImplicationGraph(sink, file, entries, byId, limits, budget) {
  const edges = new Map()
  let unknownEdges = 0
  let depthExceeded = false

  for (const entry of entries) {
    budget.check()
    const targets = []
    for (const target of entry.refs) {
      const pointer = entry.refPointers.get(target)

      if (target === entry.id) {
        sink.add({
          file,
          pointer,
          ruleId: 'scope-implication-self',
          message: `Scope "${excerpt(entry.id, 120)}" implies itself; holding a scope already means holding it, so the edge carries no information and was dropped.`,
        })
        continue
      }

      if (!byId.has(target)) {
        unknownEdges += 1
        sink.add({
          file,
          pointer,
          ruleId: 'scope-implication-unknown',
          message: `Scope "${excerpt(entry.id, 120)}" implies "${excerpt(target, 120)}", which this catalog does not declare; the edge was not followed and nothing was assumed about what it would have granted.`,
          suggestion: 'Declare the implied scope, or remove the implication.',
        })
        continue
      }

      targets.push(target)
    }
    edges.set(entry.id, targets)
  }

  /**
   * Transitive reach, one breadth-first walk per scope.
   *
   * The visited set is what makes a cycle terminate: `a implies b`, `b implies
   * a` is a declaration somebody will write, and it must produce a report
   * rather than a hung process. The walk is by depth level, so which of two
   * equally deep scopes is dequeued first cannot change the result -- the
   * frontier is therefore not sorted, because a sort whose order cannot reach
   * output is a sort nobody can test.
   */
  const reach = new Map()
  for (const entry of entries) {
    budget.check()
    const seen = new Set()
    let frontier = edges.get(entry.id) ?? []
    let depth = 1

    while (frontier.length > 0) {
      if (depth > limits.maxImplicationDepth) {
        depthExceeded = true
        sink.add({
          file,
          pointer: entry.pointer,
          ruleId: 'implication-depth-exceeded',
          message: `Expanding the implications of scope "${excerpt(entry.id, 120)}" passed the maxImplicationDepth limit of ${limits.maxImplicationDepth}; the walk stopped there, so the effective set below is a floor and not the whole of it.`,
          suggestion: 'Raise --max-implication-depth, or flatten the implication chain.',
        })
        break
      }
      const next = []
      for (const id of frontier) {
        if (seen.has(id)) continue
        seen.add(id)
        for (const target of edges.get(id) ?? []) if (!seen.has(target)) next.push(target)
      }
      frontier = next
      depth += 1
    }

    reach.set(entry.id, seen)
  }

  /**
   * Mutually implying groups, reported once each.
   *
   * A cycle is not an error: the closure is still well defined and every member
   * of the group is equivalent to every other. It is worth saying out loud,
   * because a group of mutually implying scopes is almost always a modelling
   * mistake and it makes "the least-required set" ambiguous -- any one member
   * would do, and this tool picks the first by code unit so that the answer is
   * the same on every machine.
   */
  const cycles = []
  const assigned = new Set()
  // Declared order, deliberately unsorted: a mutually reachable group is the
  // same set of scopes whichever member the scan starts from, and both the
  // anchor and the evidence below are taken from the group sorted by code unit.
  // Sorting here would order something no output can show.
  for (const id of reach.keys()) {
    if (assigned.has(id)) continue
    const members = [id]
    for (const other of reach.get(id)) {
      if (other !== id && reach.get(other)?.has(id)) members.push(other)
    }
    if (members.length === 1) continue
    for (const member of members) assigned.add(member)
    const sorted = members.sort(byCodeUnit)
    cycles.push(sorted)
    sink.add({
      file,
      pointer: byId.get(sorted[0]).pointer,
      ruleId: 'scope-implication-cycle',
      message: `Scopes ${sorted.map((member) => `"${excerpt(member, 60)}"`).join(', ')} imply one another, so holding any one of them means holding all of them; the walk terminated on its visited set rather than following the loop.`,
      evidence: `cycle: ${sorted.join(', ')}`,
      suggestion: 'Break the loop so that one scope is the broader one.',
    })
  }

  return { edges, reach, cycles, unknownEdges, depthExceeded }
}

/**
 * Every scope a set of declared scopes actually confers: the scopes themselves
 * plus everything they declare an implication to, transitively.
 *
 * Names not in the catalog never reach this function -- the caller has already
 * reported them and left them out -- which is the whole point: an unknown name
 * contributes nothing to an effective set, so it can never make an operation
 * look covered.
 */
export function closureOf(graph, ids) {
  const effective = new Set()
  for (const id of ids) {
    if (!graph.reach.has(id)) continue
    effective.add(id)
    for (const target of graph.reach.get(id)) effective.add(target)
  }
  return effective
}
