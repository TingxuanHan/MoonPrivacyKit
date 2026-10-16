///|
priv struct DisclosureCell {
  id : String
  lower : Int32
  upper : Int32
  is_protected : Bool
  min_width : Int32
}

///|
priv struct DisclosureEquation {
  id : String
  indices : Array[Int32]
  total : Int32
  published : Bool
}

///|
priv struct DisclosureSearch {
  mut nodes : Int32
  mut solutions : Int32
  mut complete : Bool
  minimum : Array[Int32]
  maximum : Array[Int32]
}

///|
fn disclosure_propagate(
  lower : Array[Int32],
  upper : Array[Int32],
  equations : Array[DisclosureEquation],
) -> Bool {
  let mut changed = true
  while changed {
    changed = false
    for eq in equations {
      let mut lo = 0
      let mut hi = 0
      for i in eq.indices {
        lo += lower[i]
        hi += upper[i]
      }
      if eq.total < lo || eq.total > hi {
        return false
      }
      for i in eq.indices {
        let new_lo = eq.total - (hi - upper[i])
        let new_hi = eq.total - (lo - lower[i])
        if new_lo > lower[i] {
          lower[i] = new_lo
          changed = true
        }
        if new_hi < upper[i] {
          upper[i] = new_hi
          changed = true
        }
        if lower[i] > upper[i] {
          return false
        }
      }
    }
  }
  true
}

///|
fn disclosure_visit(
  lower : Array[Int32],
  upper : Array[Int32],
  equations : Array[DisclosureEquation],
  state : DisclosureSearch,
  limit : Int32,
) -> Unit {
  if state.nodes >= limit {
    state.complete = false
    return
  }
  state.nodes += 1
  if !disclosure_propagate(lower, upper, equations) {
    return
  }
  let mut selected = -1
  let mut width = 10001
  for i in 0..<lower.length() {
    let gap = upper[i] - lower[i]
    if gap > 0 && gap < width {
      selected = i
      width = gap
    }
  }
  if selected == -1 {
    state.solutions += 1
    for i in 0..<lower.length() {
      if lower[i] < state.minimum[i] {
        state.minimum[i] = lower[i]
      }
      if upper[i] > state.maximum[i] {
        state.maximum[i] = upper[i]
      }
    }
    return
  }
  for value = lower[selected]; value <= upper[selected]; value = value + 1 {
    let next_lo = lower.copy()
    let next_hi = upper.copy()
    next_lo[selected] = value
    next_hi[selected] = value
    disclosure_visit(next_lo, next_hi, equations, state, limit)
    if !state.complete {
      return
    }
  }
}

///|
fn disclosure_solve(
  cells : Array[DisclosureCell],
  equations : Array[DisclosureEquation],
  limit : Int32,
) -> DisclosureSearch {
  let state = {
    nodes: 0,
    solutions: 0,
    complete: true,
    minimum: Array::make(cells.length(), 10001),
    maximum: Array::make(cells.length(), -1),
  }
  disclosure_visit(
    cells.map(c => c.lower),
    cells.map(c => c.upper),
    equations,
    state,
    limit,
  )
  state
}

///|
fn disclosure_has_risk(
  cells : Array[DisclosureCell],
  state : DisclosureSearch,
) -> Bool {
  if !state.complete || state.solutions == 0 {
    return false
  }
  for i in 0..<cells.length() {
    if cells[i].is_protected &&
      state.maximum[i] - state.minimum[i] < cells[i].min_width {
      return true
    }
  }
  false
}

///|
/// Inspect only declared exact nonnegative counts and public bounds. Noisy
/// releases, inferred population equivalence and implicit equations are rejected.
/// Exhaustion never produces a no-risk verdict. Repairs retain every publication.
pub fn inspect_disclosure(input : Json) -> Json raise KitError {
  require_keys(input, [
    "schema_version", "kind", "cohort", "cells", "equations", "node_limit",
  ])
  let version = decode_int(field(input, "schema_version"))
  let kind : String = decode(field(input, "kind"))
  let cohort : String = decode(field(input, "cohort"))
  let limit = decode_int(field(input, "node_limit"))
  if version != 1 ||
    kind != "exact-counts" ||
    cohort.length() < 1 ||
    cohort.length() > 80 ||
    limit < 100 ||
    limit > 20000 {
    raise KitError(
      "use exact-counts version 1, a declared cohort and a node limit of 100 to 20000",
    )
  }
  let raw_cells : Array[Json] = decode(field(input, "cells"))
  let raw_equations : Array[Json] = decode(field(input, "equations"))
  if raw_cells.length() < 1 ||
    raw_cells.length() > 12 ||
    raw_equations.length() < 1 ||
    raw_equations.length() > 24 {
    raise KitError(
      "disclosure inspection accepts 1 to 12 cells and 1 to 24 equations",
    )
  }
  let cells : Array[DisclosureCell] = []
  let names : Array[String] = []
  for cell in raw_cells {
    require_keys(cell, ["id", "lower", "upper", "protected", "min_width"])
    let id : String = decode(field(cell, "id"))
    let lower = decode_int(field(cell, "lower"))
    let upper = decode_int(field(cell, "upper"))
    let is_protected : Bool = decode(field(cell, "protected"))
    let min_width = decode_int(field(cell, "min_width"))
    if id.length() < 1 ||
      id.length() > 80 ||
      names.contains(id) ||
      lower < 0 ||
      upper > 10000 ||
      lower > upper ||
      min_width < 1 ||
      min_width > 10000 {
      raise KitError(
        "invalid or duplicate cell, public bound or protection width",
      )
    }
    names.push(id)
    cells.push({ id, lower, upper, is_protected, min_width, })
  }
  if !cells.any(c => c.is_protected) {
    raise KitError("declare at least one protected cell")
  }
  let equations : Array[DisclosureEquation] = []
  let equation_ids : Array[String] = []
  for equation in raw_equations {
    require_keys(equation, ["id", "cells", "total", "published"])
    let id : String = decode(field(equation, "id"))
    let members : Array[String] = decode(field(equation, "cells"))
    let total = decode_int(field(equation, "total"))
    let published : Bool = decode(field(equation, "published"))
    if id.length() < 1 ||
      id.length() > 80 ||
      equation_ids.contains(id) ||
      members.length() < 1 ||
      members.length() > cells.length() ||
      total < 0 ||
      total > 120000 {
      raise KitError("invalid or duplicate equation")
    }
    let indices : Array[Int32] = []
    for name in members {
      let mut index = -1
      for i in 0..<names.length() {
        if names[i] == name {
          index = i
        }
      }
      if index < 0 || indices.contains(index) {
        raise KitError("equations require distinct declared cells")
      }
      indices.push(index)
    }
    equation_ids.push(id)
    equations.push({ id, indices, total, published, })
  }
  let state = disclosure_solve(cells, equations, limit)
  let status = if !state.complete {
    "inconclusive"
  } else if state.solutions == 0 {
    "inconsistent"
  } else if disclosure_has_risk(cells, state) {
    "risk_found"
  } else {
    "no_risk_in_model"
  }
  let findings : Array[Json] = []
  if state.complete && state.solutions > 0 {
    for i in 0..<cells.length() {
      if cells[i].is_protected {
        findings.push({
          "cell": Json(cells[i].id),
          "minimum": Json(state.minimum[i]),
          "maximum": Json(state.maximum[i]),
          "required_width": Json(cells[i].min_width),
          "risk": Json(state.maximum[i] - state.minimum[i] < cells[i].min_width),
          "evidence_equations": Json(equation_ids),
        })
      }
    }
  }
  let repairs : Array[Json] = []
  let mut attempts = 0
  if status == "risk_found" {
    // Bounded candidate search: single draft removals and pairs. The list is
    // neither an exhaustive search nor a claim of minimum utility loss.
    for first in 0..<equations.length() {
      if equations[first].published {
        continue
      }
      for second = first; second < equations.length(); second = second + 1 {
        if attempts >= 16 {
          break
        }
        if equations[second].published {
          continue
        }
        attempts += 1
        let retained : Array[DisclosureEquation] = []
        let removed : Array[String] = []
        for i in 0..<equations.length() {
          if i == first || i == second {
            removed.push(equations[i].id)
          } else {
            retained.push(equations[i])
          }
        }
        let candidate = disclosure_solve(cells, retained, limit)
        if candidate.complete &&
          candidate.solutions > 0 &&
          !disclosure_has_risk(cells, candidate) {
          repairs.push({
            "remove_drafts": Json(removed),
            "status": "no_risk_in_model",
          })
        }
      }
    }
  }
  {
    "schema_version": 1,
    "kind": "moonprivacykit/disclosure-inspection",
    "cohort": Json(cohort),
    "status": Json(status),
    "nodes": Json(state.nodes),
    "complete": Json(state.complete),
    "findings": Json(findings),
    "repairs": Json(repairs),
    "repair_candidates_checked": Json(attempts),
    "repair_search_exhaustive": false,
    "scope": "declared exact count equations and public bounds only; local review, not a DP guarantee",
  }
}
