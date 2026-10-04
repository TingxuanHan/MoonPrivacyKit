///|
pub struct CsvTable {
  headers : Array[String]
  rows : Array[Array[String]]
} derive(ToJson)

///|
pub extend CsvTable with ToJson::{to_json}

///|
/// Strict comma-delimited UTF-8 CSV, with CRLF/LF and quoted embedded newlines.
pub fn parse_csv(input : String) -> CsvTable raise KitError {
  if input.is_empty() || input.length() > 2_000_000 {
    raise KitError("CSV must contain a header and at most 2 million text units")
  }
  let chars = input.iter().to_array()
  let records : Array[Array[String]] = []
  let mut row : Array[String] = []
  let cell = StringBuilder()
  let mut state = 0 // 0: unquoted, 1: inside quotes, 2: closing quote seen
  let mut i = if chars[0] == '\u{FEFF}' { 1 } else { 0 }
  while i < chars.length() {
    let c = chars[i]
    if state == 1 {
      if c == '"' {
        if i + 1 < chars.length() && chars[i + 1] == '"' {
          cell.write_char('"')
          i = i + 1
        } else {
          state = 2
        }
      } else {
        cell.write_char(c)
      }
    } else if c == ',' {
      row.push(cell.to_string())
      cell.reset()
      state = 0
    } else if c == '\r' || c == '\n' {
      row.push(cell.to_string())
      records.push(row)
      row = []
      cell.reset()
      state = 0
      if c == '\r' && i + 1 < chars.length() && chars[i + 1] == '\n' {
        i = i + 1
      }
    } else if c == '"' && state == 0 && cell.is_empty() {
      state = 1
    } else if state == 2 || c == '"' {
      raise KitError(
        "CSV has an unexpected quote or text after a closing quote",
      )
    } else {
      cell.write_char(c)
    }
    if row.length() > 512 || records.length() > 100001 {
      raise KitError("CSV exceeds the row or column limit")
    }
    i = i + 1
  }
  if state == 1 {
    raise KitError("CSV contains an unclosed quoted field")
  }
  if state == 2 || !cell.is_empty() || !row.is_empty() {
    row.push(cell.to_string())
    records.push(row)
  }
  if records.is_empty() {
    raise KitError("CSV header is missing")
  }
  let headers = records[0]
  if headers.length() > 512 {
    raise KitError("CSV exceeds the column limit")
  }
  let names : Map[String, Bool] = Map([])
  for header in headers {
    if header.trim().is_empty() || names.contains(header) {
      raise KitError("CSV column names must be nonempty and unique")
    }
    names[header] = true
  }
  let rows : Array[Array[String]] = []
  for index = 1; index < records.length(); index = index + 1 {
    if records[index].length() != headers.length() {
      raise KitError("CSV rows do not all match the header width")
    }
    rows.push(records[index])
  }
  { headers, rows, }
}

///|
pub(all) struct FieldPolicy {
  remove : Array[String]
  mask : Array[String]
} derive(ToJson, @json.FromJson)

///|
pub extend FieldPolicy with ToJson::{to_json}

///|
pub extend FieldPolicy with @json.FromJson::{from_json}

///|
fn validate_policy(
  policy : FieldPolicy,
  fields : Array[String],
) -> Unit raise KitError {
  if policy.remove.is_empty() && policy.mask.is_empty() {
    raise KitError("select at least one field to remove or mask")
  }
  let selected : Map[String, Bool] = Map([])
  for key in policy.remove + policy.mask {
    if !fields.contains(key) || selected.contains(key) {
      raise KitError(
        "selected fields must exist, be unique and have one action each",
      )
    }
    selected[key] = true
  }
}

///|
pub struct RedactionAudit {
  records : Int
  removed_values : Int
  masked_values : Int
  spreadsheet_escapes : Int
} derive(ToJson)

///|
pub extend RedactionAudit with ToJson::{to_json}

///|
pub struct RedactionResult {
  output : String
  audit : RedactionAudit
} derive(ToJson)

///|
pub extend RedactionResult with ToJson::{to_json}

///|
fn formula_like(value : String) -> Bool {
  let text = value.trim_start()
  text.has_prefix("=") ||
  text.has_prefix("+") ||
  text.has_prefix("-") ||
  text.has_prefix("@") ||
  value.has_prefix("\t") ||
  value.has_prefix("\r") ||
  value.has_prefix("\n")
}

///|
fn csv_quote(value : String) -> String {
  "\"" + value.replace(old="\"", new="\"\"") + "\""
}

///|
/// Spreadsheet escaping prefixes formula-like cells with an apostrophe.
/// This is a sharing format; it may change negative numeric cells into text.
pub fn redact_csv(
  input : String,
  policy : FieldPolicy,
  spreadsheet_safe? : Bool = true,
) -> RedactionResult raise KitError {
  let table = parse_csv(input)
  validate_policy(policy, table.headers)
  let kept : Array[Int] = []
  for i = 0; i < table.headers.length(); i = i + 1 {
    if !policy.remove.contains(table.headers[i]) {
      kept.push(i)
    }
  }
  if kept.is_empty() {
    raise KitError("CSV export must retain at least one column")
  }
  let lines : Array[String] = []
  let mut escapes = 0
  let headers : Array[String] = []
  for i in kept {
    let value = table.headers[i]
    if spreadsheet_safe && formula_like(value) {
      headers.push(csv_quote("'" + value))
      escapes = escapes + 1
    } else {
      headers.push(csv_quote(value))
    }
  }
  lines.push(headers.join(","))
  for row in table.rows {
    let cells : Array[String] = []
    for i in kept {
      let value = if policy.mask.contains(table.headers[i]) {
        "[REDACTED]"
      } else {
        row[i]
      }
      if spreadsheet_safe && formula_like(value) {
        cells.push(csv_quote("'" + value))
        escapes = escapes + 1
      } else {
        cells.push(csv_quote(value))
      }
    }
    lines.push(cells.join(","))
  }
  {
    output: lines.join("\r\n") + "\r\n",
    audit: {
      records: table.rows.length(),
      removed_values: table.rows.length() * policy.remove.length(),
      masked_values: table.rows.length() * policy.mask.length(),
      spreadsheet_escapes: escapes,
    },
  }
}
