///|
/// Reusable settings only. A template never carries a ledger or release identity.
pub struct StatisticsTemplate {
  name : String
  query : String
  unit_field : String
  category_field : String
  categories : Array[String]
  epsilon : String
  max_contributions : Int
}

///|
pub extend StatisticsTemplate with ToJson::{to_json}

///|
pub impl ToJson for StatisticsTemplate with fn to_json(self) {
  let settings : Map[String, Json] = Map([
    ("query", self.query.to_json()),
    ("unitField", self.unit_field.to_json()),
    ("epsilon", self.epsilon.to_json()),
    ("maxContributions", self.max_contributions.to_json()),
  ])
  if self.query == "histogram" {
    settings["categoryField"] = self.category_field.to_json()
    settings["categories"] = self.categories.to_json()
  }
  {
    "schemaVersion": 1,
    "kind": "moonprivacykit/statistics-template",
    "name": self.name.to_json(),
    "settings": Json::object(settings),
  }
}

///|
pub struct TemplateCompatibility {
  compatible : Bool
  missing_fields : Array[String]
  issue : String
} derive(ToJson)

///|
pub extend TemplateCompatibility with ToJson::{to_json}

///|
fn template_epsilon(value : String) -> Double raise KitError {
  let chars = value.iter().to_array()
  if chars.is_empty() || chars.length() > 8 || chars[0] < '0' || chars[0] > '8' {
    raise KitError(
      "template epsilon must be a decimal string from 0.01 to 8 with at most six fractional digits",
    )
  }
  if chars.length() > 1 {
    if chars.length() < 3 || chars[1] != '.' {
      raise KitError("invalid template epsilon decimal format")
    }
    for i = 2; i < chars.length(); i = i + 1 {
      if chars[i] < '0' || chars[i] > '9' {
        raise KitError("invalid template epsilon decimal format")
      }
    }
  }
  let epsilon : Double = decode(read_json(value))
  if epsilon < 0.01 || epsilon > 8.0 {
    raise KitError("template epsilon must be between 0.01 and 8")
  }
  epsilon
}

///|
fn template_mapping(template : StatisticsTemplate) -> TableMapping {
  {
    query: template.query,
    unit_field: template.unit_field,
    category_field: template.category_field,
    categories: template.categories,
  }
}

///|
pub fn parse_statistics_template(
  input : String,
) -> StatisticsTemplate raise KitError {
  if input.length() > 100_000 {
    raise KitError("statistics template exceeds the 100000 text unit limit")
  }
  let value = read_json(input)
  reject_duplicate_table_keys(input)
  require_keys(value, ["schemaVersion", "kind", "name", "settings"])
  let kind : String = decode(field(value, "kind"))
  if decode_int(field(value, "schemaVersion")) != 1 ||
    kind != "moonprivacykit/statistics-template" {
    raise KitError("unsupported statistics template kind or version")
  }
  let name : String = decode(field(value, "name"))
  if name.trim().is_empty() ||
    name.length() > 80 ||
    name.contains("\n") ||
    name.contains("\r") {
    raise KitError("template name must be a single line of 1 to 80 characters")
  }
  let settings = field(value, "settings")
  let query : String = decode(field(settings, "query"))
  let keys = ["query", "unitField", "epsilon", "maxContributions"]
  if query == "histogram" {
    keys.push("categoryField")
    keys.push("categories")
  } else if query != "count" {
    raise KitError("template query must be count or histogram")
  }
  require_keys(settings, keys)
  let categories : Array[String] = if query == "histogram" {
    decode(field(settings, "categories"))
  } else {
    []
  }
  if categories.any(label => label.contains("\n") || label.contains("\r")) {
    raise KitError("template categories must be single-line labels")
  }
  let template : StatisticsTemplate = {
    name,
    query,
    unit_field: decode(field(settings, "unitField")),
    category_field: if query == "histogram" {
      decode(field(settings, "categoryField"))
    } else {
      ""
    },
    categories,
    epsilon: decode(field(settings, "epsilon")),
    max_contributions: decode_int(field(settings, "maxContributions")),
  }
  // Empty JSON validates mapping rules without using or retaining any real data.
  ignore(map_table("json", "[]", template_mapping(template)))
  ignore(
    make_central_mechanism(
      if query == "histogram" {
        categories.length()
      } else {
        1
      },
      template_epsilon(template.epsilon),
      template.max_contributions,
    ),
  )
  template
}

///|
/// This is a trusted-holder validation result, not a private statistical output.
/// No sampling, budget accounting, row counts or original values are returned.
pub fn check_statistics_template(
  template : StatisticsTemplate,
  format : String,
  input : String,
) -> TemplateCompatibility raise KitError {
  let checked = parse_statistics_template(template.to_json().stringify())
  let fields = inspect_fields(format, input)
  let required = [checked.unit_field]
  if checked.query == "histogram" &&
    checked.category_field != checked.unit_field {
    required.push(checked.category_field)
  }
  let missing = required.filter(name => !fields.contains(name))
  if !missing.is_empty() {
    return {
      compatible: false,
      missing_fields: missing,
      issue: "missing_fields",
    }
  }
  try {
    ignore(map_table(format, input, template_mapping(checked)))
    { compatible: true, missing_fields: [], issue: "", }
  } catch {
    KitError(_) =>
      { compatible: false, missing_fields: [], issue: "invalid_values", }
  }
}
