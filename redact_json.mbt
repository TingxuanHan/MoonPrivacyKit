///|
fn json_records(
  input : String,
) -> (Array[Map[String, Json]], Bool) raise KitError {
  if input.length() > 2_000_000 {
    raise KitError("JSON exceeds the 2 million text unit limit")
  }
  match read_json(input) {
    Object(fields) => ([fields], false)
    Array(values) => {
      if values.length() > 100000 {
        raise KitError("JSON exceeds the record limit")
      }
      let rows : Array[Map[String, Json]] = []
      for value in values {
        match value {
          Object(fields) => rows.push(fields)
          _ => raise KitError("JSON records must all be objects")
        }
      }
      (rows, true)
    }
    _ => raise KitError("JSON must be an object or an array of objects")
  }
}

///|
fn record_fields(rows : Array[Map[String, Json]]) -> Array[String] {
  let fields : Array[String] = []
  for row in rows {
    for key, _ in row {
      if !fields.contains(key) {
        fields.push(key)
      }
    }
  }
  fields
}

///|
/// JSON field policies target exact TOP-LEVEL names. Masking an object replaces
/// the whole value; unselected nested values are preserved and need review.
pub fn redact_json(
  input : String,
  policy : FieldPolicy,
) -> RedactionResult raise KitError {
  let (rows, array) = json_records(input)
  validate_policy(policy, record_fields(rows))
  let output : Array[Json] = []
  let mut removed = 0
  let mut masked = 0
  for row in rows {
    let fields : Map[String, Json] = Map([])
    for key, value in row {
      if policy.remove.contains(key) {
        removed = removed + 1
      } else if policy.mask.contains(key) {
        fields[key] = Json::string("[REDACTED]")
        masked = masked + 1
      } else {
        fields[key] = value
      }
    }
    output.push(Json::object(fields))
  }
  let document = if array { Json::array(output) } else { output[0] }
  {
    output: document.stringify(indent=2),
    audit: {
      records: rows.length(),
      removed_values: removed,
      masked_values: masked,
      spreadsheet_escapes: 0,
    },
  }
}

///|
pub fn inspect_fields(
  format : String,
  input : String,
) -> Array[String] raise KitError {
  match format {
    "csv" => parse_csv(input).headers
    "json" => {
      let (rows, _) = json_records(input)
      record_fields(rows)
    }
    _ => raise KitError("supported file formats are csv and json")
  }
}
