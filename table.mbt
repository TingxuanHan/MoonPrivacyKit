///|
pub(all) struct TableMapping {
  query : String
  unit_field : String
  category_field : String
  categories : Array[String]
} derive(ToJson, @json.FromJson)

///|
pub extend TableMapping with ToJson::{to_json}

///|
pub extend TableMapping with @json.FromJson::{from_json}

///|
/// Private intermediate data for the trusted holder. Never publish this value.
pub struct MappedTable {
  unit_ids : Array[String]
  category_ids : Array[Int]
} derive(ToJson)

///|
pub extend MappedTable with ToJson::{to_json}

///|
fn table_field_name(name : String) -> Unit raise KitError {
  if name.trim().is_empty() || name.length() > 256 {
    raise KitError("table field names must contain 1 to 256 characters")
  }
}

///|
/// Run after JSON syntax validation. Preserve key spellings across escapes so
/// ambiguous object keys cannot silently change a privacy unit or category.
fn reject_duplicate_table_keys(input : String) -> Unit raise KitError {
  let chars = input.iter().to_array()
  let objects : Array[Map[String, Bool]] = []
  let mut i = 0
  while i < chars.length() {
    match chars[i] {
      '{' => objects.push(Map([]))
      '}' => ignore(objects.pop())
      '"' => {
        let literal = StringBuilder()
        literal.write_char('"')
        i = i + 1
        let mut escaped = false
        while i < chars.length() {
          let c = chars[i]
          literal.write_char(c)
          if c == '"' && !escaped {
            break
          }
          escaped = c == '\\' && !escaped
          i = i + 1
        }
        let mut next = i + 1
        while next < chars.length() &&
              (
                chars[next] == ' ' ||
                chars[next] == '\t' ||
                chars[next] == '\r' ||
                chars[next] == '\n'
              ) {
          next = next + 1
        }
        if next < chars.length() && chars[next] == ':' {
          match read_json(literal.to_string()) {
            String(key) => {
              let keys = objects[objects.length() - 1]
              if keys.contains(key) {
                raise KitError(
                  "JSON table objects must not contain duplicate keys",
                )
              }
              keys[key] = true
            }
            _ => raise KitError("invalid JSON table key")
          }
        }
      }
      _ => ()
    }
    i = i + 1
  }
}

///|
fn table_string(row : Map[String, Json], key : String) -> String raise KitError {
  match row.get(key) {
    Some(String(value)) => value
    _ =>
      raise KitError("every mapped JSON field must exist and contain a string")
  }
}

///|
fn push_table_record(
  mapped : MappedTable,
  unit : String,
  category : String,
  bins : Map[String, Int],
  histogram : Bool,
) -> Unit raise KitError {
  if unit.is_empty() || unit.length() > 128 || unit.trim() != unit {
    raise KitError(
      "table unit identifiers must contain 1 to 128 characters without surrounding whitespace",
    )
  }
  let bin = if histogram {
    match bins.get(category) {
      Some(index) => index
      None =>
        raise KitError("table category is outside the predefined public domain")
    }
  } else {
    0
  }
  mapped.unit_ids.push(unit)
  mapped.category_ids.push(bin)
}

///|
/// Strict top-level mapping. Every row is checked, including contributions that
/// the later statistic will clip. No guessing, coercion, trimming or row drops.
pub fn map_table(
  format : String,
  input : String,
  mapping : TableMapping,
) -> MappedTable raise KitError {
  table_field_name(mapping.unit_field)
  let histogram = match mapping.query {
    "count" => {
      if !mapping.category_field.is_empty() || !mapping.categories.is_empty() {
        raise KitError("count mappings do not accept category fields or labels")
      }
      false
    }
    "histogram" => {
      table_field_name(mapping.category_field)
      if mapping.categories.is_empty() || mapping.categories.length() > 256 {
        raise KitError(
          "declare 1 to 256 public categories before reading the table",
        )
      }
      true
    }
    _ => raise KitError("table query must be count or histogram")
  }
  let bins : Map[String, Int] = Map([])
  for i = 0; i < mapping.categories.length(); i = i + 1 {
    let label = mapping.categories[i]
    if label.trim().is_empty() || label.length() > 128 || bins.contains(label) {
      raise KitError(
        "public category labels must be nonempty distinct strings of at most 128 characters",
      )
    }
    bins[label] = i
  }
  let mapped : MappedTable = { unit_ids: [], category_ids: [], }
  match format {
    "csv" => {
      let table = parse_csv(input)
      let unit_column = match table.headers.search(mapping.unit_field) {
        Some(index) => index
        None =>
          raise KitError("mapped unit field is missing from the CSV header")
      }
      let category_column = if histogram {
        match table.headers.search(mapping.category_field) {
          Some(index) => index
          None =>
            raise KitError(
              "mapped category field is missing from the CSV header",
            )
        }
      } else {
        0
      }
      for row in table.rows {
        push_table_record(
          mapped,
          row[unit_column],
          row[category_column],
          bins,
          histogram,
        )
      }
    }
    "json" => {
      let (rows, _) = json_records(input)
      reject_duplicate_table_keys(input)
      ignore(record_fields(rows))
      for row in rows {
        let unit = table_string(row, mapping.unit_field)
        let category = if histogram {
          table_string(row, mapping.category_field)
        } else {
          ""
        }
        push_table_record(mapped, unit, category, bins, histogram)
      }
    }
    _ => raise KitError("supported table formats are csv and json")
  }
  mapped
}
