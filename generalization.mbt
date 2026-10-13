///|
pub struct GeneralizedField {
  name : String
  action : String
  precision : String
  categories : Array[String]
} derive(ToJson)

///|
pub extend GeneralizedField with ToJson::{to_json}

///|
fn validate_age_boundaries(values : Array[Int]) -> Unit raise KitError {
  if values.is_empty() || values.length() > 32 {
    raise KitError("age rules require 1 to 32 public boundaries")
  }
  let mut previous = 0
  for value in values {
    if value <= previous || value > 130 {
      raise KitError("age boundaries must be increasing integers from 1 to 130")
    }
    previous = value
  }
}

///|
fn age_categories(boundaries : Array[Int]) -> Array[String] {
  let labels : Array[String] = []
  let mut lower = 0
  for upper in boundaries {
    labels.push("\{lower}-\{upper - 1}")
    lower = upper
  }
  labels.push("\{lower}+")
  labels
}

///|
fn age_value(value : Json) -> Int raise KitError {
  let age = match value {
    Number(_) => decode_int(value)
    String(text) => {
      let chars = text.iter().to_array()
      if chars.is_empty() ||
        chars.length() > 3 ||
        (chars.length() > 1 && chars[0] == '0') ||
        chars.any(c => c < '0' || c > '9') {
        raise KitError("ages must be canonical integers from 0 to 130")
      }
      decode_int(read_json(text))
    }
    _ => raise KitError("age values must be integer numbers or integer text")
  }
  if age < 0 || age > 130 {
    raise KitError("ages must be integers from 0 to 130")
  }
  age
}

///|
fn date_digits(chars : Array[Char], start : Int, length : Int) -> Int {
  let mut result = 0
  for i = start; i < start + length; i = i + 1 {
    result = result * 10 + chars[i].to_int() - '0'.to_int()
  }
  result
}

///|
/// Calendar dates only: no timezone conversion, rollover, trimming or guessing.
fn reduced_date(value : Json, precision : String) -> String raise KitError {
  let text : String = decode(value)
  let chars = text.iter().to_array()
  if chars.length() != 10 {
    raise KitError("dates must use YYYY-MM-DD")
  }
  for i = 0; i < 10; i = i + 1 {
    if i == 4 || i == 7 {
      if chars[i] != '-' {
        raise KitError("dates must use YYYY-MM-DD")
      }
    } else if chars[i] < '0' || chars[i] > '9' {
      raise KitError("dates must use YYYY-MM-DD")
    }
  }
  let year = date_digits(chars, 0, 4)
  let month = date_digits(chars, 5, 2)
  let day = date_digits(chars, 8, 2)
  if year < 1 || month < 1 || month > 12 {
    raise KitError("dates must be valid Gregorian calendar dates")
  }
  let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
  let days = [
    31,
    if leap {
      29
    } else {
      28
    },
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if day < 1 || day > days[month - 1] {
    raise KitError("dates must be valid Gregorian calendar dates")
  }
  let output = StringBuilder()
  let length = if precision == "month" { 7 } else { 4 }
  for i = 0; i < length; i = i + 1 {
    output.write_char(chars[i])
  }
  output.to_string()
}

///|
fn generalized_value(rule : FieldRule, value : Json) -> Json raise KitError {
  if rule.action == "age" {
    let age = age_value(value)
    let mut index = 0
    for boundary in rule.boundaries {
      if age >= boundary {
        index = index + 1
      }
    }
    age_categories(rule.boundaries)[index].to_json()
  } else {
    reduced_date(value, rule.precision).to_json()
  }
}

///|
fn generalized_field_descriptions(
  template : RedactionTemplate,
) -> Array[GeneralizedField] {
  template.fields
  .filter(f => f.action == "age" || f.action == "date")
  .map(f => {
    name: f.name,
    action: f.action,
    precision: f.precision,
    // Derive labels from public rule parameters, never the private records.
    categories: if f.action == "age" {
      age_categories(f.boundaries)
    } else {
      []
    },
  })
}

///|
fn validate_generalization_values(
  template : RedactionTemplate,
  format : String,
  input : String,
) -> Unit raise KitError {
  let rules = template.fields.filter(f => {
    f.action == "age" || f.action == "date"
  })
  if rules.is_empty() {
    return
  }
  if format == "csv" {
    let table = parse_csv(input)
    for rule in rules {
      let column = match table.headers.search(rule.name) {
        Some(i) => i
        None => raise KitError("generalized column is missing")
      }
      for row in table.rows {
        ignore(generalized_value(rule, row[column].to_json()))
      }
    }
  } else {
    let (rows, _) = json_records(input)
    for row in rows {
      for rule in rules {
        let value = match row.get(rule.name) {
          Some(value) => value
          None =>
            raise KitError("every generalized field must exist in every record")
        }
        ignore(generalized_value(rule, value))
      }
    }
  }
}

///|
fn apply_generalized_template(
  template : RedactionTemplate,
  format : String,
  input : String,
) -> RedactionResult raise KitError {
  let rules : Map[String, FieldRule] = Map([])
  for rule in template.fields {
    rules[rule.name] = rule
  }
  if format == "csv" {
    let source = parse_csv(input)
    let kept = source.headers.filter(h => rules[h].action != "remove")
    let output : Array[Array[String]] = []
    for row in source.rows {
      let values : Array[String] = []
      for i = 0; i < source.headers.length(); i = i + 1 {
        let rule = rules[source.headers[i]]
        match rule.action {
          "remove" => ()
          "mask" => values.push("[REDACTED]")
          "keep" => values.push(row[i])
          _ => values.push(decode(generalized_value(rule, row[i].to_json())))
        }
      }
      output.push(values)
    }
    let (text, escapes) = serialize_csv(
      { headers: kept, rows: output, },
      template.spreadsheet_safe,
    )
    {
      output: text,
      audit: {
        records: source.rows.length(),
        removed_values: source.rows.length() *
        template.fields.filter(f => f.action == "remove").length(),
        masked_values: source.rows.length() *
        template.fields.filter(f => f.action == "mask").length(),
        generalized_values: source.rows.length() *
        template.fields
        .filter(f => f.action == "age" || f.action == "date")
        .length(),
        spreadsheet_escapes: escapes,
      },
    }
  } else {
    let (rows, array) = json_records(input)
    let output : Array[Json] = []
    let mut removed = 0
    let mut masked = 0
    let mut generalized = 0
    for row in rows {
      let result : Map[String, Json] = Map([])
      for key, value in row {
        match rules[key].action {
          "remove" => removed = removed + 1
          "mask" => {
            result[key] = Json::string("[REDACTED]")
            masked = masked + 1
          }
          "keep" => result[key] = value
          _ => {
            result[key] = generalized_value(rules[key], value)
            generalized = generalized + 1
          }
        }
      }
      output.push(Json::object(result))
    }
    let document = if array { Json::array(output) } else { output[0] }
    {
      output: document.stringify(indent=2),
      audit: {
        records: rows.length(),
        removed_values: removed,
        masked_values: masked,
        generalized_values: generalized,
        spreadsheet_escapes: 0,
      },
    }
  }
}
