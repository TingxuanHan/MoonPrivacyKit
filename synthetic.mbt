///|
priv struct SyntheticField {
  name : String
  categories : Array[String]
  parent : Int32
  offset : Int32
} derive(ToJson)

///|
priv struct SyntheticPlan {
  unit_field : String
  output_rows : Int32
  fields : Array[SyntheticField]
  cells : Int32
}

///|
fn parse_synthetic_plan(input : Json) -> SyntheticPlan raise KitError {
  require_keys(input, ["schema_version", "unit_field", "output_rows", "fields"])
  let unit_field : String = decode(field(input, "unit_field"))
  table_field_name(unit_field)
  if unit_field.contains("\n") || unit_field.contains("\r") {
    raise KitError("synthetic field names must be single lines")
  }
  let output_rows = decode_int(field(input, "output_rows"))
  let entries : Array[Json] = decode(field(input, "fields"))
  if decode_int(field(input, "schema_version")) != 1 ||
    output_rows < 1 ||
    output_rows > 5000 ||
    entries.length() < 1 ||
    entries.length() > 6 {
    raise KitError(
      "synthetic plan requires version 1, 1 to 6 fields and 1 to 5000 public output rows",
    )
  }
  let fields : Array[SyntheticField] = []
  let names : Map[String, Bool] = Map([])
  let mut cells = 0
  for i in 0..<entries.length() {
    let entry = entries[i]
    require_keys(entry, ["name", "categories", "parent"])
    let name : String = decode(field(entry, "name"))
    table_field_name(name)
    if name.contains("\n") || name.contains("\r") {
      raise KitError("synthetic field names must be single lines")
    }
    let categories : Array[String] = decode(field(entry, "categories"))
    let parent = decode_int(field(entry, "parent"))
    if name == unit_field ||
      names.contains(name) ||
      categories.length() < 1 ||
      categories.length() > 8 ||
      (i == 0 && parent != -1) ||
      (i > 0 && (parent < 0 || parent >= i)) {
      raise KitError(
        "synthetic fields must be distinct, exclude the person identifier and form a public ordered tree with 1 to 8 categories per field",
      )
    }
    let seen : Map[String, Bool] = Map([])
    for label in categories {
      if label.trim().is_empty() ||
        label.length() > 128 ||
        seen.contains(label) ||
        label.contains("\n") ||
        label.contains("\r") {
        raise KitError(
          "synthetic categories require distinct nonempty public single-line labels of at most 128 characters",
        )
      }
      seen[label] = true
    }
    names[name] = true
    let width = if i == 0 { 1 } else { fields[parent].categories.length() }
    fields.push({ name, categories, parent, offset: cells, })
    cells = cells + width * categories.length()
  }
  if cells > 256 {
    raise KitError(
      "synthetic public tree exceeds the limit of 256 measurement cells",
    )
  }
  { unit_field, output_rows, fields, cells, }
}

///|
/// The tree, domains and output size are public declarations, never inferred
/// from the private input. One person contributes one cell per measurement.
pub fn plan_synthetic(input : Json) -> Json raise KitError {
  let plan = parse_synthetic_plan(input)
  {
    "schema_version": 1,
    "kind": "moonprivacykit/public-tree-plan",
    "l1_sensitivity": Json(plan.fields.length()),
    "measurement_cells": Json(plan.cells),
    "output_rows": Json(plan.output_rows),
    "fields": Json(plan.fields),
  }
}

///|
/// Private mapping for the trusted holder only. Never persist or export this
/// intermediate. Invalid-input errors are not a public query interface.
pub fn map_synthetic(
  input : Json,
  format : String,
  source : String,
) -> Json raise KitError {
  let plan = parse_synthetic_plan(input)
  let rows = person_rows(format, source)
  if rows.length() > 10000 {
    raise KitError("synthetic input is limited to 10000 people")
  }
  let units : Array[String] = []
  let bins : Array[Int32] = []
  let seen : Map[String, Bool] = Map([])
  for row in rows {
    let id = person_id(row, plan.unit_field)
    if seen.contains(id) {
      raise KitError(
        "synthetic input requires exactly one row per person; duplicate identifiers are rejected",
      )
    }
    seen[id] = true
    let values : Array[Int32] = []
    for f in plan.fields {
      let value = table_string(row, f.name)
      let bin = match f.categories.search(value) {
        Some(index) => index
        None =>
          raise KitError(
            "synthetic input contains a value outside the predefined public domain",
          )
      }
      let parent_bin = if f.parent == -1 { 0 } else { values[f.parent] }
      values.push(bin)
      units.push(id)
      bins.push(f.offset + parent_bin * f.categories.length() + bin)
    }
  }
  { "unit_ids": Json(units), "category_ids": Json(bins) }
}

///|
fn synthetic_sample(
  input : Json,
  counts : Array[Int32],
  random_below : (Int32) -> Int32,
) -> Json raise KitError {
  let plan = parse_synthetic_plan(input)
  if counts.length() != plan.cells ||
    counts.any(n => n < 0 || n > CENTRAL_RECORD_LIMIT) {
    raise KitError(
      "synthetic model requires bounded protected counts for every public measurement cell",
    )
  }
  let rows : Array[Array[String]] = []
  for _ in 0..<plan.output_rows {
    let indices : Array[Int32] = []
    let row : Array[String] = []
    for f in plan.fields {
      let start = f.offset +
        (if f.parent == -1 { 0 } else { indices[f.parent] }) *
        f.categories.length()
      let mut total = 0
      for j in 0..<f.categories.length() {
        // Fixed public smoothing; empty/noisy-zero conditionals stay defined.
        total = total + counts[start + j] + 1
      }
      let draw = if total == 1 { 0 } else { random_below(total) }
      if draw < 0 || draw >= total {
        raise KitError("synthetic random source returned an invalid draw")
      }
      let mut remaining = draw
      let mut chosen = 0
      for j in 0..<f.categories.length() {
        let weight = counts[start + j] + 1
        if remaining < weight {
          chosen = j
          break
        }
        remaining = remaining - weight
      }
      indices.push(chosen)
      row.push(f.categories[chosen])
    }
    rows.push(row)
  }
  let columns = plan.fields.map(f => f.name)
  let (csv, escaped) = serialize_csv({ headers: columns, rows, }, true)
  {
    "schema_version": 1,
    "kind": "moonprivacykit/synthetic-table",
    "method": "public-tree-geometric-v1",
    "plan": input,
    "columns": Json(columns),
    "rows": Json(rows),
    "csv": Json(csv),
    "csv_escaped_cells": Json(escaped),
    "smoothing": 1,
  }
}

///|
/// Postprocessing boundary: only public metadata and already protected counts.
/// This function does not read private tables or spend a new privacy budget.
pub fn dispatch_synthetic(
  input : String,
  random_below : (Int32) -> Int32,
) -> String {
  let result : Json = try {
    if input.length() > 100000 {
      raise KitError("synthetic model request exceeds input limit")
    }
    let request = read_json(input)
    let result = synthetic_sample(
      field(request, "plan"),
      decode_ints(field(request, "counts")),
      random_below,
    )
    { "ok": true, "data": result }
  } catch {
    KitError(message) => { "ok": false, "error": message }
  }
  result.stringify()
}
