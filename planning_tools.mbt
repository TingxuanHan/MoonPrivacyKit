///|
fn planning_fields(value : Json) -> Array[String] raise KitError {
  let fields : Array[String] = decode(value)
  if fields.is_empty() || fields.length() > 12 {
    raise KitError("select 1 to 12 visible fields")
  }
  let seen : Map[String, Bool] = Map([])
  for name in fields {
    table_field_name(name)
    if seen.contains(name) {
      raise KitError("duplicate selected field")
    }
    seen[name] = true
  }
  fields
}

///|
fn planning_k(value : Json) -> Int32 raise KitError {
  let k = decode_int(value)
  if k < 2 || k > 10000 {
    raise KitError("k must be 2 to 10000")
  }
  k
}

///|
fn planning_rows(
  format : String,
  input : String,
) -> Array[Map[String, Json]] raise KitError {
  let rows = person_rows(format, input)
  if rows.is_empty() || rows.length() > 10000 {
    raise KitError("analysis requires 1 to 10000 rows")
  }
  rows
}

///|
fn planning_tuple(
  row : Map[String, Json],
  fields : Array[String],
) -> Array[Json] raise KitError {
  fields.map(name => {
    match row.get(name) {
      None => Json([Json("missing")])
      Some(value) =>
        match value {
          Null | True | False | Number(_) | String(_) =>
            Json([Json("value"), value])
          _ => raise KitError("selected analysis fields must be scalar")
        }
    }
  })
}

///|
fn planning_sizes(tuples : Array[Array[Json]]) -> Array[Int32] {
  let counts : Map[String, Int32] = Map([])
  let keys = tuples.map(t => Json(t).stringify())
  for key in keys {
    counts[key] = counts.get(key).unwrap_or(0) + 1
  }
  keys.map(key => counts.get(key).unwrap_or(0))
}

///|
fn planning_metrics(sizes : Array[Int32], k : Int32) -> Json {
  let mut minimum = 10001
  let mut unique = 0
  let mut below = 0
  for size in sizes {
    if size < minimum {
      minimum = size
    }
    if size == 1 {
      unique += 1
    }
    if size < k {
      below += 1
    }
  }
  {
    "rows": Json(sizes.length()),
    "minimum_group": Json(minimum),
    "unique_fraction": Json(unique.to_double() / sizes.length().to_double()),
    "below_k_fraction": Json(below.to_double() / sizes.length().to_double()),
  }
}

///|
fn planning_missing(
  rows : Array[Map[String, Json]],
  fields : Array[String],
) -> Int32 {
  rows
  .filter(row => {
    fields.any(name => {
      match row.get(name) {
        None | Some(Null) => true
        _ => false
      }
    })
  })
  .length()
}

///|
fn planning_loss(template : RedactionTemplate) -> Double {
  let mut total = 0.0
  for rule in template.fields {
    total += match rule.action {
      "keep" => 0.0
      "age" => {
        let mut lower = 0
        let mut largest = 0
        for upper in rule.boundaries {
          if upper - lower > largest {
            largest = upper - lower
          }
          lower = upper
        }
        if 131 - lower > largest {
          largest = 131 - lower
        }
        (largest - 1).to_double() / 130.0
      }
      "date" => if rule.precision == "month" { 0.5 } else { 0.8 }
      _ => 1.0
    }
  }
  total / template.fields.length().to_double()
}

///|
pub fn compare_privacy_plans(
  format : String,
  input : String,
  config : Json,
) -> Json raise KitError {
  require_keys(config, [
    "schema_version", "quasi_fields", "required_unchanged", "k", "candidates",
  ])
  if decode_int(field(config, "schema_version")) != 1 {
    raise KitError("unsupported analysis version")
  }
  let fields = planning_fields(field(config, "quasi_fields"))
  let required : Array[String] = decode(field(config, "required_unchanged"))
  let k = planning_k(field(config, "k"))
  let candidates : Array[Json] = decode(field(config, "candidates"))
  if candidates.is_empty() || candidates.length() > 64 {
    raise KitError("provide 1 to 64 candidates")
  }
  let source = planning_rows(format, input)
  let available = record_fields(source)
  if fields.any(f => !available.contains(f)) ||
    required.any(f => !available.contains(f)) {
    raise KitError("selected fields are unavailable")
  }
  let results : Array[Json] = []
  let losses : Array[Double] = []
  let risks : Array[Double] = []
  let feasible : Array[Bool] = []
  let names : Map[String, Bool] = Map([])
  for candidate in candidates {
    let template = parse_redaction_template(candidate.stringify())
    if names.contains(template.name) {
      raise KitError("candidate names must be unique")
    }
    names[template.name] = true
    let result = apply_redaction_template(template, format, input)
    let rows = planning_rows(format, result.output)
    let retained = template.fields
      .filter(f => f.action != "remove")
      .map(f => f.name)
    let visible = fields.filter(f => retained.contains(f))
    let sizes = planning_sizes(rows.map(r => planning_tuple(r, visible)))
    let metrics = planning_metrics(sizes, k)
    let risk : Double = decode(field(metrics, "below_k_fraction"))
    let loss = planning_loss(template)
    let kept = required.all(name => {
      template.fields.any(f => f.name == name && f.action == "keep")
    })
    let ok = risk == 0.0 && kept
    losses.push(loss)
    risks.push(risk)
    feasible.push(ok)
    results.push({
      "name": Json(template.name),
      "metrics": metrics,
      "missing_rows": Json(planning_missing(rows, visible)),
      "loss_index": Json(loss),
      "retained_rows_fraction": 1,
      "retained_fields_fraction": Json(
        retained.length().to_double() / template.fields.length().to_double(),
      ),
      "required_unchanged_met": Json(kept),
      "meets_constraints": Json(ok),
      "fields": Json(template.fields),
    })
  }
  let frontier : Array[String] = []
  for i in 0..<results.length() {
    if feasible[i] {
      let mut dominated = false
      for j in 0..<results.length() {
        if feasible[j] &&
          risks[j] <= risks[i] &&
          losses[j] <= losses[i] &&
          (risks[j] < risks[i] || losses[j] < losses[i]) {
          dominated = true
        }
      }
      if !dominated {
        frontier.push(decode(field(results[i], "name")))
      }
    }
  }
  {
    "schema_version": 1,
    "kind": "moonprivacykit/private-plan-comparison",
    "k": Json(k),
    "baseline": planning_metrics(
      planning_sizes(source.map(r => planning_tuple(r, fields))),
      k,
    ),
    "candidates": Json(results),
    "frontier": Json(frontier),
    "private_analysis": true,
  }
}

///|
pub fn compare_private_versions(
  left_format : String,
  left_text : String,
  right_format : String,
  right_text : String,
  config : Json,
) -> Json raise KitError {
  require_keys(config, [
    "schema_version", "unit_field", "left_fields", "right_fields", "k", "assume_linkable",
  ])
  let linked : Bool = decode(field(config, "assume_linkable"))
  if decode_int(field(config, "schema_version")) != 1 || !linked {
    raise KitError("declare the same-person linkage assumption")
  }
  let unit : String = decode(field(config, "unit_field"))
  table_field_name(unit)
  let lf = planning_fields(field(config, "left_fields"))
  let rf = planning_fields(field(config, "right_fields"))
  if lf.contains(unit) || rf.contains(unit) {
    raise KitError("private identity must not be a visible field")
  }
  let k = planning_k(field(config, "k"))
  let left = planning_rows(left_format, left_text)
  let right = planning_rows(right_format, right_text)
  if left.length() != right.length() {
    raise KitError("versions must contain the same people")
  }
  if lf.any(f => !record_fields(left).contains(f)) ||
    rf.any(f => !record_fields(right).contains(f)) {
    raise KitError("visible fields are missing")
  }
  let index : Map[String, Map[String, Json]] = Map([])
  for row in right {
    let id = person_id(row, unit)
    if index.contains(id) {
      raise KitError("versions require one row per person")
    }
    index[id] = row
  }
  let seen : Map[String, Bool] = Map([])
  let lt : Array[Array[Json]] = []
  let rt : Array[Array[Json]] = []
  let jt : Array[Array[Json]] = []
  for row in left {
    let id = person_id(row, unit)
    if seen.contains(id) {
      raise KitError("versions require one row per person")
    }
    seen[id] = true
    let other = match index.get(id) {
      Some(row) => row
      None => raise KitError("missing private correspondence")
    }
    let a = planning_tuple(row, lf)
    let b = planning_tuple(other, rf)
    lt.push(a)
    rt.push(b)
    jt.push([Json(a), Json(b)])
  }
  let ls = planning_sizes(lt)
  let rs = planning_sizes(rt)
  let js = planning_sizes(jt)
  let mut smaller = 0
  let mut newly_at_risk = 0
  for i in 0..<js.length() {
    if js[i] < ls[i] || js[i] < rs[i] {
      smaller += 1
    }
    if js[i] < k && ls[i] >= k && rs[i] >= k {
      newly_at_risk += 1
    }
  }
  {
    "schema_version": 1,
    "kind": "moonprivacykit/private-version-comparison",
    "k": Json(k),
    "left": planning_metrics(ls, k),
    "right": planning_metrics(rs, k),
    "joint": planning_metrics(js, k),
    "smaller_group_rows": Json(smaller),
    "newly_below_k_rows": Json(newly_at_risk),
    "left_fields": Json(lf),
    "right_fields": Json(rf),
    "assumption": "same cohort; one row per person; correct linkability",
    "private_analysis": true,
  }
}
