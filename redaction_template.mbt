///|
pub struct FieldRule {
  name : String
  action : String
  boundaries : Array[Int32]
  precision : String
}

///|
pub extend FieldRule with ToJson::{to_json}

///|
pub impl ToJson for FieldRule with fn to_json(self) {
  let fields : Map[String, Json] = Map([
    ("name", Json(self.name)),
    ("action", Json(self.action)),
  ])
  if self.action == "age" {
    fields["boundaries"] = Json(self.boundaries)
  }
  if self.action == "date" {
    fields["precision"] = Json(self.precision)
  }
  Json::object(fields)
}

///|
pub struct RedactionTemplate {
  schema_version : Int32
  name : String
  fields : Array[FieldRule]
  spreadsheet_safe : Bool
}

///|
pub extend RedactionTemplate with ToJson::{to_json}

///|
pub impl ToJson for RedactionTemplate with fn to_json(self) {
  {
    "schemaVersion": Json(self.schema_version),
    "kind": "moonprivacykit/redaction-template",
    "name": Json(self.name),
    "settings": {
      "fields": Json(self.fields),
      "spreadsheetSafe": Json(self.spreadsheet_safe),
    },
  }
}

///|
pub struct RedactionCompatibility {
  compatible : Bool
  missing_fields : Array[String]
  unexpected_fields : Array[String]
  issue : String
} derive(ToJson)

///|
pub extend RedactionCompatibility with ToJson::{to_json}

///|
pub struct RedactionHandoff {
  result : RedactionResult
  eligible_fields : Array[String]
  excluded_fields : Array[String]
  generalized_fields : Array[GeneralizedField]
} derive(ToJson)

///|
pub extend RedactionHandoff with ToJson::{to_json}

///|
fn redaction_template_policy(template : RedactionTemplate) -> FieldPolicy {
  {
    remove: template.fields.filter(f => f.action == "remove").map(f => f.name),
    mask: template.fields.filter(f => f.action == "mask").map(f => f.name),
  }
}

///|
/// All columns must have an explicit decision, including columns kept unchanged.
pub fn parse_redaction_template(
  input : String,
) -> RedactionTemplate raise KitError {
  if input.length() > 100_000 {
    raise KitError("redaction template exceeds the 100000 text unit limit")
  }
  let value = read_json(input)
  reject_duplicate_table_keys(input)
  require_keys(value, ["schemaVersion", "kind", "name", "settings"])
  let kind : String = decode(field(value, "kind"))
  let version = decode_int(field(value, "schemaVersion"))
  if (version != 1 && version != 2) ||
    kind != "moonprivacykit/redaction-template" {
    raise KitError("unsupported redaction template kind or version")
  }
  let name : String = decode(field(value, "name"))
  if name.trim().is_empty() ||
    name.length() > 80 ||
    name.contains("\n") ||
    name.contains("\r") {
    raise KitError("template name must be a single line of 1 to 80 characters")
  }
  let settings = field(value, "settings")
  require_keys(settings, ["fields", "spreadsheetSafe"])
  let rules : Array[Json] = decode(field(settings, "fields"))
  if rules.is_empty() || rules.length() > 512 {
    raise KitError("redaction templates require 1 to 512 field rules")
  }
  let seen : Map[String, Bool] = Map([])
  let fields : Array[FieldRule] = []
  for rule in rules {
    let action : String = decode(field(rule, "action"))
    let keys = ["name", "action"]
    if version == 2 && action == "age" {
      keys.push("boundaries")
    }
    if version == 2 && action == "date" {
      keys.push("precision")
    }
    require_keys(rule, keys)
    let key : String = decode(field(rule, "name"))
    table_field_name(key)
    if seen.contains(key) {
      raise KitError("template field rules must have unique names")
    }
    seen[key] = true
    let boundaries = if version == 2 && action == "age" {
      let values = decode_ints(field(rule, "boundaries"))
      validate_age_boundaries(values)
      values
    } else {
      []
    }
    let precision : String = if version == 2 && action == "date" {
      let value : String = decode(field(rule, "precision"))
      if value != "month" && value != "year" {
        raise KitError("date precision must be month or year")
      }
      value
    } else {
      ""
    }
    if action != "keep" &&
      action != "remove" &&
      action != "mask" &&
      !(version == 2 && (action == "age" || action == "date")) {
      raise KitError("unsupported field action for this template version")
    }
    fields.push({ name: key, action, boundaries, precision, })
  }
  let template : RedactionTemplate = {
    schema_version: version,
    name,
    fields,
    spreadsheet_safe: decode(field(settings, "spreadsheetSafe")),
  }
  if fields.all(f => f.action == "keep") {
    raise KitError("select at least one field to remove, mask or generalize")
  }
  template
}

///|
pub fn check_redaction_template(
  template : RedactionTemplate,
  format : String,
  input : String,
) -> RedactionCompatibility raise KitError {
  let checked = parse_redaction_template(template.to_json().stringify())
  let fields = inspect_fields(format, input)
  if format == "json" {
    reject_duplicate_table_keys(input)
  }
  let expected = checked.fields.map(f => f.name)
  let missing = expected.filter(name => !fields.contains(name))
  let unexpected = fields.filter(name => !expected.contains(name))
  let issue = if !missing.is_empty() || !unexpected.is_empty() {
    "field_mismatch"
  } else if format == "csv" && checked.fields.all(f => f.action == "remove") {
    "no_remaining_columns"
  } else {
    try {
      validate_generalization_values(checked, format, input)
      ""
    } catch {
      KitError(_) => "invalid_values"
    }
  }
  {
    compatible: issue.is_empty(),
    missing_fields: missing,
    unexpected_fields: unexpected,
    issue,
  }
}

///|
pub fn apply_redaction_template(
  template : RedactionTemplate,
  format : String,
  input : String,
) -> RedactionResult raise KitError {
  if !check_redaction_template(template, format, input).compatible {
    raise KitError(
      "redaction template is incompatible with the input fields or format",
    )
  }
  let policy = redaction_template_policy(template)
  if template.fields.any(f => f.action == "age" || f.action == "date") {
    return apply_generalized_template(template, format, input)
  }
  if format == "csv" {
    redact_csv(input, policy, spreadsheet_safe=template.spreadsheet_safe)
  } else {
    redact_json(input, policy)
  }
}

///|
/// Handoff metadata is for the trusted holder, not a public privacy report.
/// Only unchanged kept columns qualify as identities. Generalized columns may
/// be used as categories with explicitly reviewed public domains.
pub fn prepare_redaction_handoff(
  template : RedactionTemplate,
  format : String,
  input : String,
) -> RedactionHandoff raise KitError {
  let result = apply_redaction_template(template, format, input)
  let eligible = template.fields
    .filter(f => f.action == "keep")
    .map(f => f.name)
  let generalized = generalized_field_descriptions(template)
  if format == "csv" {
    let before = parse_csv(input)
    // Reject ambiguous output headers (including collisions introduced by escaping).
    let after = parse_csv(result.output)
    let unchanged = eligible.filter(name => {
      match (before.headers.search(name), after.headers.search(name)) {
        (Some(a), Some(b)) => {
          let mut same = before.rows.length() == after.rows.length()
          for i = 0; same && i < before.rows.length(); i = i + 1 {
            same = before.rows[i][a] == after.rows[i][b]
          }
          same && (!template.spreadsheet_safe || !formula_like(name))
        }
        _ => false
      }
    })
    let usable = generalized.filter(f => {
      after.headers.contains(f.name) &&
      (!template.spreadsheet_safe || !formula_like(f.name))
    })
    {
      result,
      eligible_fields: unchanged,
      excluded_fields: template.fields
      .map(f => f.name)
      .filter(name => {
        !unchanged.contains(name) && !usable.any(f => f.name == name)
      }),
      generalized_fields: usable,
    }
  } else {
    {
      result,
      eligible_fields: eligible,
      excluded_fields: template.fields
      .map(f => f.name)
      .filter(name => {
        !eligible.contains(name) && !generalized.any(f => f.name == name)
      }),
      generalized_fields: generalized,
    }
  }
}
