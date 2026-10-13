///|
fn generalization_fixture(rules : Array[Json]) -> Json {
  {
    "schemaVersion": 2,
    "kind": "moonprivacykit/redaction-template",
    "name": "公开分段配置",
    "settings": { "fields": rules.to_json(), "spreadsheetSafe": true },
  }
}

///|
fn generalization_rule(action : String) -> Json {
  if action == "age" {
    { "name": "value", "action": "age", "boundaries": [18, 30, 45, 60] }
  } else {
    { "name": "value", "action": "date", "precision": "month" }
  }
}

///|
test "version two validates public rule parameters and keeps version one compatible" {
  let value = generalization_fixture([
    generalization_rule("age"),
    { "name": "date", "action": "date", "precision": "year" },
  ])
  assert_eq(parse_redaction_template(value.stringify()).to_json(), value)
  template_set(value, "schemaVersion", Json::number(1))
  assert_true(redaction_rejects(value.stringify()))
  let invalid_boundaries : Array[Json] = [
    [],
    [0],
    [131],
    [30, 18],
    [18, 18],
    [1.5],
    ["18"],
  ]
  for boundaries in invalid_boundaries {
    let rule = generalization_rule("age")
    template_set(rule, "boundaries", boundaries)
    assert_true(redaction_rejects(generalization_fixture([rule]).stringify()))
  }
  for precision in ["day", "week", "", "Year"] {
    let rule = generalization_rule("date")
    template_set(rule, "precision", precision.to_json())
    assert_true(redaction_rejects(generalization_fixture([rule]).stringify()))
  }
  let extra = generalization_rule("age")
  template_set(extra, "precision", Json::string("secret"))
  assert_true(redaction_rejects(generalization_fixture([extra]).stringify()))
  let old = redaction_fixture()
  assert_eq(parse_redaction_template(old.stringify()).to_json(), old)
}

///|
test "age bands cover the supported integer domain and fixed boundary endpoints" {
  let template = parse_redaction_template(
    generalization_fixture([generalization_rule("age")]).stringify(),
  )
  let rule = template.fields[0]
  assert_eq(age_categories(rule.boundaries), [
    "0-17", "18-29", "30-44", "45-59", "60+",
  ])
  for age = 0; age <= 130; age = age + 1 {
    let expected = if age < 18 {
      "0-17"
    } else if age < 30 {
      "18-29"
    } else if age < 45 {
      "30-44"
    } else if age < 60 {
      "45-59"
    } else {
      "60+"
    }
    assert_eq(generalized_value(rule, age.to_json()), expected.to_json())
    assert_eq(
      generalized_value(rule, age.to_string().to_json()),
      expected.to_json(),
    )
  }
  assert_eq(age_categories([1, 130]), ["0-0", "1-129", "130+"])
}

///|
test "date reduction validates Gregorian dates before discarding day and month" {
  for
    (input, month, year) in [
      ("2000-02-29", "2000-02", "2000"),
      ("2024-02-29", "2024-02", "2024"),
      ("1900-02-28", "1900-02", "1900"),
      ("0001-01-01", "0001-01", "0001"),
      ("9999-12-31", "9999-12", "9999"),
    ] {
    assert_eq(reduced_date(input.to_json(), "month"), month)
    assert_eq(reduced_date(input.to_json(), "year"), year)
  }
  for
    input in [
      "1900-02-29", "2100-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00",
      "0000-01-01", "2026-1-01", "2026/01/01", "2026-01-01T00:00:00Z", " 2026-01-01",
      "2026-01-01\n",
    ] {
    for precision in ["month", "year"] {
      let rejected = try {
        ignore(reduced_date(input.to_json(), precision))
        false
      } catch {
        KitError(message) => {
          assert_true(!message.contains(input))
          true
        }
      }
      assert_true(rejected)
    }
  }
}

///|
test "invalid or missing generalized values block the whole operation without disclosure" {
  let template = parse_redaction_template(
    generalization_fixture([generalization_rule("age")]).stringify(),
  )
  for
    value in [
      Json::null(),
      Json::boolean(true),
      Json::number(-1),
      Json::number(131),
      Json::number(18.5),
      Json::string("018"),
      Json::string("18.0"),
      Json::string("1e2"),
      Json::string(" 18"),
      Json::string("+18"),
      Json::string("secret-age"),
      Json::string(""),
    ] {
    let input = Json::array([{ "value": 23 }, { "value": value }]).stringify()
    assert_eq(
      check_redaction_template(template, "json", input).issue,
      "invalid_values",
    )
    let rejected = try {
      ignore(apply_redaction_template(template, "json", input))
      false
    } catch {
      KitError(message) => {
        assert_true(!message.contains("secret"))
        true
      }
    }
    assert_true(rejected)
  }
  assert_eq(
    check_redaction_template(template, "json", "[{\"value\":23},{}]").issue,
    "invalid_values",
  )
  for text in ["value\n23\n018", "value\n23\n\"\"", "value\n23\nsecret-age"] {
    assert_eq(
      check_redaction_template(template, "csv", text).issue,
      "invalid_values",
    )
  }
}

///|
test "mixed transformations preserve rows identities quoting and legacy audit shape" {
  let template = parse_redaction_template(
    generalization_fixture([
      { "name": "id", "action": "keep" },
      generalization_rule("age"),
      { "name": "date", "action": "date", "precision": "year" },
      { "name": "contact", "action": "remove" },
      { "name": "memo", "action": "mask" },
    ]).stringify(),
  )
  let csv = "id,value,date,contact,memo\n\"p\"\"a\"\"b\",18,2000-02-29,secret,secret\n=p2,130,9999-12-31,secret,secret"
  let result = apply_redaction_template(template, "csv", csv)
  let rows = parse_csv(result.output).rows
  assert_eq(rows, [
    ["p\"a\"b", "18-29", "2000", "[REDACTED]"],
    ["'=p2", "60+", "9999", "[REDACTED]"],
  ])
  assert_eq(result.audit.generalized_values, 4)
  assert_eq(result.audit.removed_values, 2)
  assert_eq(result.audit.masked_values, 2)
  assert_eq(result.audit.spreadsheet_escapes, 1)
  assert_true(!result.audit.to_json().stringify().contains("secret"))
  let legacy = redact_json("{\"id\":\"p1\",\"contact\":\"secret\"}", {
    remove: ["contact"],
    mask: [],
  })
  assert_eq(legacy.audit.to_json(), {
    "records": 1,
    "removed_values": 1,
    "masked_values": 0,
    "spreadsheet_escapes": 0,
  })
}

///|
test "handoff distinguishes unchanged identities from public generalized categories" {
  let template = parse_redaction_template(
    generalization_fixture([
      { "name": "id", "action": "keep" },
      generalization_rule("age"),
      { "name": "date", "action": "date", "precision": "month" },
    ]).stringify(),
  )
  let first = prepare_redaction_handoff(
    template, "csv", "id,value,date\np1,23,2000-02-29",
  )
  let empty = prepare_redaction_handoff(template, "csv", "id,value,date\n")
  let json = prepare_redaction_handoff(
    template, "json", "{\"id\":\"p2\",\"value\":130,\"date\":\"9999-12-31\"}",
  )
  assert_eq(first.eligible_fields, ["id"])
  assert_eq(first.excluded_fields, [])
  assert_eq(
    first.generalized_fields.to_json(),
    empty.generalized_fields.to_json(),
  )
  assert_eq(
    first.generalized_fields.to_json(),
    json.generalized_fields.to_json(),
  )
  assert_eq(first.generalized_fields[0].categories, [
    "0-17", "18-29", "30-44", "45-59", "60+",
  ])
  assert_eq(first.generalized_fields[1].categories, [])
  let escaped = parse_redaction_template(
    generalization_fixture([
      { "name": "id", "action": "keep" },
      { "name": "=age", "action": "age", "boundaries": [18] },
    ]).stringify(),
  )
  let handoff = prepare_redaction_handoff(escaped, "csv", "id,=age\np1,18")
  assert_eq(handoff.generalized_fields.length(), 0)
  assert_eq(handoff.excluded_fields, ["=age"])
}
