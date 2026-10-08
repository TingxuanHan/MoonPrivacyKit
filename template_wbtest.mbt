///|
fn template_fixture(query : String) -> Json {
  let settings : Map[String, Json] = Map([
    ("query", query.to_json()),
    ("unitField", Json::string("person_id")),
    ("epsilon", Json::string("0.3")),
    ("maxContributions", Json::number(1.0)),
  ])
  if query == "histogram" {
    settings["categoryField"] = Json::string("answer")
    settings["categories"] = ["满意", "一般", "不满意"].to_json()
  }
  {
    "schemaVersion": 1,
    "kind": "moonprivacykit/statistics-template",
    "name": "统计方案",
    "settings": Json::object(settings),
  }
}

///|
fn template_set(value : Json, key : String, replacement : Json) -> Unit {
  match value {
    Object(fields) => fields[key] = replacement
    _ => ()
  }
}

///|
fn template_rejects(input : String) -> Bool raise {
  try {
    ignore(parse_statistics_template(input))
    false
  } catch {
    KitError(message) => {
      assert_true(!message.contains("secret"))
      true
    }
  }
}

///|
test "statistics templates round trip count and histogram without execution identity" {
  for query in ["count", "histogram"] {
    let input = template_fixture(query)
    let parsed = parse_statistics_template(input.stringify())
    assert_eq(parsed.query, query)
    assert_eq(parsed.epsilon, "0.3")
    assert_eq(parsed.to_json(), input)
    assert_true(!parsed.to_json().stringify().contains("requestId"))
    assert_true(!parsed.to_json().stringify().contains("scope"))
  }
}

///|
test "templates refuse unknown fields including ledger identities and raw records" {
  for target in ["root", "settings"] {
    for
      key in [
        "scope", "requestId", "totalEpsilon", "spentEpsilon", "unitIds", "data",
      ] {
      let document = template_fixture("count")
      template_set(
        if target == "root" {
          document
        } else {
          field(document, "settings")
        },
        key,
        Json::string("secret-value"),
      )
      assert_true(template_rejects(document.stringify()))
    }
  }
  let document = template_fixture("count")
  template_set(field(document, "settings"), "categories", ["yes"].to_json())
  assert_true(template_rejects(document.stringify()))
}

///|
test "templates reject unsupported versions fractional limits and wrong scalar types" {
  for
    (key, value) in [
      ("schemaVersion", Json::number(2.0)),
      ("schemaVersion", Json::number(1.5)),
      ("schemaVersion", Json::string("1")),
      ("kind", Json::string("other")),
      ("name", Json::string("")),
      ("name", Json::string("line\nbreak")),
    ] {
    let document = template_fixture("count")
    template_set(document, key, value)
    assert_true(template_rejects(document.stringify()))
  }
  for
    (key, value) in [
      ("maxContributions", Json::number(1.5)),
      ("maxContributions", Json::number(0.0)),
      ("maxContributions", Json::number(33.0)),
      ("epsilon", Json::number(0.3)),
      ("unitField", Json::string("")),
      ("query", Json::string("sum")),
    ] {
    let document = template_fixture("count")
    template_set(field(document, "settings"), key, value)
    assert_true(template_rejects(document.stringify()))
  }
}

///|
test "template budget decimals retain precision and reject coercion or rounding" {
  for value in ["0.01", "0.010000", "0.123456", "8", "8.000000"] {
    let document = template_fixture("count")
    template_set(field(document, "settings"), "epsilon", value.to_json())
    assert_eq(parse_statistics_template(document.stringify()).epsilon, value)
  }
  for
    value in [
      "0", "0.009999", "8.000001", "9", "0.1000000", ".3", "00.3", "1e-1", "0.3 ",
      "1.", "NaN",
    ] {
    let document = template_fixture("count")
    template_set(field(document, "settings"), "epsilon", value.to_json())
    assert_true(template_rejects(document.stringify()))
  }
}

///|
test "template categories preserve meaning and reject duplicates or multiline values" {
  for categories in [[], [""], ["yes", "yes"], ["line\nbreak"], ["line\rbreak"]] {
    let document = template_fixture("histogram")
    template_set(
      field(document, "settings"),
      "categories",
      categories.to_json(),
    )
    assert_true(template_rejects(document.stringify()))
  }
  let document = template_fixture("histogram")
  template_set(
    field(document, "settings"),
    "categories",
    [" yes ", "yes"].to_json(),
  )
  assert_eq(parse_statistics_template(document.stringify()).categories, [
    " yes ", "yes",
  ])
}

///|
test "template compatibility checks fields and every mapped record without revealing input" {
  let template = parse_statistics_template(
    template_fixture("histogram").stringify(),
  )
  assert_true(
    check_statistics_template(template, "csv", "person_id,answer\np1,满意").compatible,
  )
  assert_true(
    check_statistics_template(
      template, "json", "[{\"person_id\":\"p1\",\"answer\":\"一般\"}]",
    ).compatible,
  )
  assert_true(
    check_statistics_template(template, "csv", "person_id,answer").compatible,
  )
  let missing = check_statistics_template(
    template, "csv", "other\nsecret-value",
  )
  assert_eq(missing.missing_fields, ["person_id", "answer"])
  assert_eq(missing.issue, "missing_fields")
  for
    input in [
      "[{\"person_id\":\"secret-person\",\"answer\":\"secret-category\"}]", "[{\"person_id\":1,\"answer\":\"满意\"}]",
      "[{\"person_id\":\"p1\",\"answer\":\"满意\"},{\"person_id\":\"p1\"}]", "[{\"person_id\":\"p1\",\"person_id\":\"p2\",\"answer\":\"满意\"}]",
    ] {
    let result = check_statistics_template(template, "json", input)
    assert_true(!result.compatible)
    assert_eq(result.issue, "invalid_values")
    assert_true(!result.to_json().stringify().contains("secret"))
  }
}
