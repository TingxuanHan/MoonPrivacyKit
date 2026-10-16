///|
priv struct PersonQuery {
  unit_field : String
  left_cap : Int32
  right_cap : Int32
  output_cap : Int32
  query : String
  value_field : String
  value_upper : Int32
}

///|
fn parse_person_query(input : Json) -> PersonQuery raise KitError {
  require_keys(input, [
    "schema_version", "join", "unit_field", "left_cap", "right_cap", "output_cap",
    "query", "value_field", "value_upper",
  ])
  let version = decode_int(field(input, "schema_version"))
  let join : String = decode(field(input, "join"))
  let unit_field : String = decode(field(input, "unit_field"))
  table_field_name(unit_field)
  let left_cap = decode_int(field(input, "left_cap"))
  let right_cap = decode_int(field(input, "right_cap"))
  let output_cap = decode_int(field(input, "output_cap"))
  let query : String = decode(field(input, "query"))
  let value_field : String = decode(field(input, "value_field"))
  let value_upper = decode_int(field(input, "value_upper"))
  if version != 1 ||
    join != "same_person_inner" ||
    left_cap < 1 ||
    left_cap > 32 ||
    right_cap < 1 ||
    right_cap > 32 ||
    output_cap < 1 ||
    output_cap > 32 {
    raise KitError(
      "person query requires version 1, same-person inner join and caps of 1 to 32",
    )
  }
  if query == "count" {
    if value_field != "" || value_upper != 1 {
      raise KitError("count requires empty value field and upper bound 1")
    }
  } else if query == "bounded_sum" {
    table_field_name(value_field)
    if value_field == unit_field || value_upper < 1 || value_upper > 1000 {
      raise KitError(
        "sum requires a separate right-table integer field and public upper bound of 1 to 1000",
      )
    }
  } else {
    raise KitError("person query supports count or bounded_sum")
  }
  {
    unit_field,
    left_cap,
    right_cap,
    output_cap,
    query,
    value_field,
    value_upper,
  }
}

///|
fn person_cap(plan : PersonQuery) -> Int32 {
  let product = plan.left_cap * plan.right_cap
  if product < plan.output_cap {
    product
  } else {
    plan.output_cap
  }
}

///|
/// Compile public constraints before touching data. Protect removal/addition of
/// all rows of one person in BOTH tables in a shared, externally established ID space.
pub fn plan_person_query(input : Json) -> Json raise KitError {
  let plan = parse_person_query(input)
  {
    "schema_version": 1,
    "kind": "moonprivacykit/person-query-plan",
    "adjacency": "add_remove_person_across_both_tables",
    "query": Json(plan.query),
    "join": "same_person_inner",
    "left_cap": Json(plan.left_cap),
    "right_cap": Json(plan.right_cap),
    "join_rows_per_person": Json(plan.left_cap * plan.right_cap),
    "output_rows_per_person": Json(person_cap(plan)),
    "value_lower": 0,
    "value_upper": Json(plan.value_upper),
    "l1_sensitivity": Json(person_cap(plan) * plan.value_upper),
    "selection": "first rows within each person, independent of other people",
  }
}

///|
fn person_rows(
  format : String,
  input : String,
) -> Array[Map[String, Json]] raise KitError {
  if input.length() > 2000000 {
    raise KitError("person table exceeds input limit")
  }
  match format {
    "csv" => {
      let csv = parse_csv(input)
      csv.rows.map(row => {
        let object : Map[String, Json] = Map([])
        for i in 0..<csv.headers.length() {
          object[csv.headers[i]] = Json(row[i])
        }
        object
      })
    }
    "json" => {
      let (rows, _) = json_records(input)
      reject_duplicate_table_keys(input)
      ignore(record_fields(rows))
      rows
    }
    _ => raise KitError("person table format must be csv or json")
  }
}

///|
fn person_id(
  row : Map[String, Json],
  field_name : String,
) -> String raise KitError {
  let id = table_string(row, field_name)
  if id.length() < 1 || id.length() > 128 || id.trim() != id {
    raise KitError("person identifiers require nonempty unchanged strings")
  }
  id
}

///|
fn person_value(
  row : Map[String, Json],
  plan : PersonQuery,
) -> Int32 raise KitError {
  if plan.query == "count" {
    return 1
  }
  let value = match row.get(plan.value_field) {
    Some(String(text)) => decode_int(read_json(text))
    Some(value) => decode_int(value)
    None => raise KitError("right table value field is missing")
  }
  if value < 0 {
    0
  } else if value > plan.value_upper {
    plan.value_upper
  } else {
    value
  }
}

///|
/// Private intermediate records. Never export these IDs or the exact values as
/// a release. Validate every input, then cap per person before and after joining.
pub fn map_person_query(
  input : Json,
  left_format : String,
  left_text : String,
  right_format : String,
  right_text : String,
) -> Json raise KitError {
  let plan = parse_person_query(input)
  let left = person_rows(left_format, left_text)
  let right = person_rows(right_format, right_text)
  if left.length() > 10000 || right.length() > 10000 {
    raise KitError("person query accepts at most 10000 rows per table")
  }
  let owners : Array[String] = []
  let left_counts : Map[String, Int32] = Map([])
  for row in left {
    let id = person_id(row, plan.unit_field)
    let count = left_counts.get(id).unwrap_or(0)
    if count == 0 {
      owners.push(id)
    }
    if count < plan.left_cap {
      left_counts[id] = count + 1
    }
  }
  let right_values : Map[String, Array[Int32]] = Map([])
  for row in right {
    let id = person_id(row, plan.unit_field)
    let value = person_value(row, plan)
    let values = match right_values.get(id) {
      Some(values) => values
      None => {
        let values = []
        right_values[id] = values
        values
      }
    }
    if values.length() < plan.right_cap {
      values.push(value)
    }
  }
  let unit_ids : Array[String] = []
  let values : Array[Int32] = []
  for id in owners {
    let mut emitted = 0
    let right_rows = right_values.get(id).unwrap_or([])
    for _ in 0..<left_counts.get(id).unwrap_or(0) {
      for value in right_rows {
        if emitted < person_cap(plan) {
          if unit_ids.length() >= CENTRAL_RECORD_LIMIT {
            raise KitError("joined private intermediate exceeds record limit")
          }
          unit_ids.push(id)
          values.push(value)
          emitted += 1
        }
      }
    }
  }
  {
    "unit_ids": Json(unit_ids),
    "values": Json(values),
    "plan": plan_person_query(input),
  }
}

///|
fn prepare_sum_request(
  request : Json,
) -> (Array[Int32], CentralMechanism, String) raise KitError {
  let ids : Array[String] = decode(field(request, "unit_ids"))
  let values = decode_ints(field(request, "values"))
  let cap = decode_int(field(request, "max_contributions"))
  let upper = decode_int(field(request, "value_upper"))
  if cap < 1 ||
    cap > 32 ||
    upper < 1 ||
    upper > 1000 ||
    ids.length() != values.length() ||
    ids.length() > CENTRAL_RECORD_LIMIT {
    raise KitError("invalid bounded integer sum dimensions or public bounds")
  }
  let mechanism = calibrate_integer_mechanism(
    1,
    decode(field(request, "epsilon")),
    cap * upper,
  )
  let counts : Map[String, Int32] = Map([])
  let mut total = 0
  for i in 0..<ids.length() {
    let id = ids[i]
    if id.length() < 1 || id.length() > 128 || id.trim() != id {
      raise KitError("invalid sum privacy unit")
    }
    let count = counts.get(id).unwrap_or(0)
    if count < cap {
      let value = if values[i] < 0 {
        0
      } else if values[i] > upper {
        upper
      } else {
        values[i]
      }
      total += value
      if total > CENTRAL_RECORD_LIMIT {
        total = CENTRAL_RECORD_LIMIT
      }
      counts[id] = count + 1
    }
  }
  ([total], mechanism, "bounded_sum")
}
