///|
fn redaction_fixture() -> Json {
  {
    "schemaVersion": 1,
    "kind": "moonprivacykit/redaction-template",
    "name": "移除联系方式",
    "settings": {
      "fields": [
        { "name": "person_id", "action": "keep" },
        { "name": "answer", "action": "keep" },
        { "name": "contact", "action": "remove" },
      ],
      "spreadsheetSafe": true,
    },
  }
}

///|
fn redaction_rejects(input : String) -> Bool raise {
  try {
    ignore(parse_redaction_template(input))
    false
  } catch {
    KitError(message) => {
      assert_true(!message.contains("secret"))
      true
    }
  }
}

///|
test "redaction templates round trip explicit decisions and work across CSV and JSON" {
  let source = redaction_fixture()
  let template = parse_redaction_template(source.stringify())
  assert_eq(template.to_json(), source)
  for
    (format, input) in [
      ("csv", "contact,answer,person_id\nsecret,满意,p1\nsecret,一般,p1"),
      (
        "json", "[{\"person_id\":\"p1\",\"answer\":\"满意\",\"contact\":\"secret\"},{\"person_id\":\"p1\",\"answer\":\"一般\",\"contact\":\"secret\"}]",
      ),
    ] {
    let prepared = prepare_redaction_handoff(template, format, input)
    assert_eq(prepared.eligible_fields, ["person_id", "answer"])
    assert_eq(prepared.excluded_fields, ["contact"])
    assert_true(!prepared.result.output.contains("secret"))
    assert_eq(prepared.result.audit.removed_values, 2)
    let mapping : TableMapping = {
      query: "histogram",
      unit_field: "person_id",
      category_field: "answer",
      categories: ["满意", "一般"],
    }
    assert_eq(
      map_table(format, input, mapping).to_json(),
      map_table(format, prepared.result.output, mapping).to_json(),
    )
  }
}

///|
test "redaction template schema rejects injected state unknown rules and ambiguous keys" {
  for key in ["scope", "requestId", "totalEpsilon", "rawData"] {
    for target in ["root", "settings", "rule"] {
      let value = redaction_fixture()
      let settings = field(value, "settings")
      let rules : Array[Json] = decode(field(settings, "fields"))
      template_set(
        if target == "root" {
          value
        } else if target == "settings" {
          settings
        } else {
          rules[0]
        },
        key,
        Json::string("secret"),
      )
      assert_true(redaction_rejects(value.stringify()))
    }
  }
  let raw = redaction_fixture().stringify()
  assert_true(
    redaction_rejects(
      raw.replace(
        old="\"schemaVersion\":1",
        new="\"schemaVersion\":1,\"schemaVersion\":1",
      ),
    ),
  )
  assert_true(
    redaction_rejects(
      raw.replace(
        old="\"action\":\"keep\"",
        new="\"action\":\"keep\",\"act\\u0069on\":\"mask\"",
      ),
    ),
  )
}

///|
test "redaction templates reject unsupported versions names actions and incomplete decisions" {
  for
    (key, replacement) in [
      ("schemaVersion", Json::number(3.0)),
      ("schemaVersion", Json::number(1.5)),
      ("name", Json::string("line\nbreak")),
      ("name", Json::string(" ")),
      ("kind", Json::string("other")),
    ] {
    let value = redaction_fixture()
    template_set(value, key, replacement)
    assert_true(redaction_rejects(value.stringify()))
  }
  for
    fields in [
      Json::array([]),
      [{ "name": "id", "action": "keep" }],
      [{ "name": "id", "action": "remove" }, { "name": "id", "action": "mask" }],
      [{ "name": "id", "action": "hash" }],
      [{ "name": " ", "action": "remove" }],
      [{ "name": "id" }],
    ] {
    let value = redaction_fixture()
    template_set(field(value, "settings"), "fields", fields)
    assert_true(redaction_rejects(value.stringify()))
  }
  let value = redaction_fixture()
  template_set(
    field(value, "settings"),
    "spreadsheetSafe",
    Json::string("true"),
  )
  assert_true(redaction_rejects(value.stringify()))
}

///|
test "compatibility requires complete field coverage including unexpected private columns" {
  let template = parse_redaction_template(redaction_fixture().stringify())
  let result = check_redaction_template(
    template, "csv", "person_id,answer,new_contact\np1,满意,secret",
  )
  assert_eq(result.missing_fields, ["contact"])
  assert_eq(result.unexpected_fields, ["new_contact"])
  assert_true(!result.compatible)
  assert_true(!result.to_json().stringify().contains("secret"))
  assert_true(
    check_redaction_template(template, "csv", "person_id,answer,contact").compatible,
  )
  assert_true(!check_redaction_template(template, "json", "[]").compatible)
  let all_removed = parse_redaction_template(
    redaction_fixture()
    .stringify()
    .replace_all(old="\"keep\"", new="\"remove\""),
  )
  assert_eq(
    check_redaction_template(all_removed, "csv", "person_id,answer,contact").issue,
    "no_remaining_columns",
  )
  assert_true(
    check_redaction_template(
      all_removed, "json", "{\"person_id\":\"p1\",\"answer\":\"a\",\"contact\":\"secret\"}",
    ).compatible,
  )
}

///|
test "handoff excludes masked identifiers even when the original equals the mask token" {
  let template = parse_redaction_template(
    redaction_fixture().stringify().replace_all(old="\"keep\"", new="\"mask\""),
  )
  let result = prepare_redaction_handoff(
    template, "csv", "person_id,answer,contact\n[REDACTED],[REDACTED],secret",
  )
  assert_eq(result.eligible_fields, [])
  assert_eq(result.excluded_fields, ["person_id", "answer", "contact"])
}

///|
test "handoff compares every CSV value and rejects escaping changes and header collisions" {
  let template = parse_redaction_template(redaction_fixture().stringify())
  let prepared = prepare_redaction_handoff(
    template, "csv", "person_id,answer,contact\np1,满意,secret\n=p2,一般,secret",
  )
  assert_eq(prepared.eligible_fields, ["answer"])
  let value = redaction_fixture()
  template_set(
    field(value, "settings"),
    "spreadsheetSafe",
    Json::boolean(false),
  )
  assert_eq(
    prepare_redaction_handoff(
      parse_redaction_template(value.stringify()),
      "csv",
      "person_id,answer,contact\n=p2,一般,secret",
    ).eligible_fields,
    ["person_id", "answer"],
  )
  let header_template = parse_redaction_template(
    redaction_fixture().stringify().replace(old="person_id", new="=id"),
  )
  assert_eq(
    prepare_redaction_handoff(
      header_template, "csv", "=id,answer,contact\np1,满意,secret",
    ).eligible_fields,
    ["answer"],
  )
  let collision_template = parse_redaction_template(
    header_template.to_json().stringify().replace(old="answer", new="'=id"),
  )
  try {
    ignore(
      prepare_redaction_handoff(
        collision_template, "csv", "=id,'=id,contact\np1,p2,secret",
      ),
    )
    fail("ambiguous output must not enter statistics")
  } catch {
    KitError(_) => ()
    _ => fail("ambiguous output was not rejected by the core")
  }
}

///|
test "template processing refuses duplicate JSON keys even in removed nested content" {
  let template = parse_redaction_template(redaction_fixture().stringify())
  for
    input in [
      "{\"person_id\":\"p1\",\"person_\\u0069d\":\"secret\",\"answer\":\"a\",\"contact\":\"secret\"}",
      "{\"person_id\":\"p1\",\"answer\":\"a\",\"contact\":{\"x\":\"secret\",\"x\":\"secret\"}}",
    ] {
    try {
      ignore(apply_redaction_template(template, "json", input))
      fail("duplicate keys must be rejected")
    } catch {
      KitError(message) => assert_true(!message.contains("secret"))
      _ => fail("duplicate input was not rejected by the core")
    }
  }
}
