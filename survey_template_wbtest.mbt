///|
fn survey_template_fixture() -> Json {
  {
    "schemaVersion": 1,
    "kind": "moonprivacykit/survey-template",
    "name": "Feedback",
    "settings": {
      "title": "Feedback survey",
      "questions": [
        {
          "id": "first",
          "title": "Satisfied?",
          "options": ["Yes", "No"],
          "epsilon": 0.25,
        },
        {
          "id": "second",
          "title": "Priority?",
          "options": ["Tools", "Time", "Space"],
          "epsilon": 0.5,
        },
      ],
      "plannedCollections": 3,
    },
  }
}

///|
fn survey_template_rejects(input : String) -> Bool raise {
  try {
    ignore(parse_survey_template(input))
    false
  } catch {
    KitError(message) => {
      assert_true(!message.contains("secret"))
      true
    }
  }
}

///|
test "questionnaire templates round trip without collection identity" {
  let source = survey_template_fixture()
  let template = parse_survey_template(source.stringify())
  assert_eq(template.to_json(), source)
  let survey = survey_from_template(template, "new-collection")
  assert_eq(survey.id, "new-collection")
  assert_eq(survey.questions[1].id, "second")
  assert_eq(survey.schema_version, 1)
  let budget = survey_budget(survey, template.planned_collections)
  assert_eq(budget.single_epsilon, 0.75)
  assert_eq(budget.total_epsilon, 2.25)
  assert_eq(budget.questions, 2)
  assert_eq(budget.collections, 3)
}

///|
test "survey template boundary rejects ambiguous and nonportable schemas" {
  let source = survey_template_fixture().stringify()
  assert_true(
    survey_template_rejects(
      source.replace(
        old="\"schemaVersion\":1",
        new="\"schemaVersion\":1,\"schemaVersion\":1",
      ),
    ),
  )
  assert_true(
    survey_template_rejects(
      source.replace(
        old="\"epsilon\":0.25",
        new="\"epsilon\":0.25,\"eps\\u0069lon\":1",
      ),
    ),
  )
  for key in ["id", "responses", "rawAnswers", "spentEpsilon", "__proto__"] {
    let value = survey_template_fixture()
    template_set(value, key, Json("secret-value"))
    assert_true(survey_template_rejects(value.stringify()))
    let nested = survey_template_fixture()
    template_set(field(nested, "settings"), key, Json("secret-value"))
    assert_true(survey_template_rejects(nested.stringify()))
  }
  for version in [0.0, 1.5, 2.0] {
    let value = survey_template_fixture()
    template_set(value, "schemaVersion", Json(version))
    assert_true(survey_template_rejects(value.stringify()))
  }
}

///|
test "planned repeat counts and editor constraints cannot be bypassed" {
  for count in [0.0, -1.0, 1.5, 10001.0] {
    let value = survey_template_fixture()
    template_set(field(value, "settings"), "plannedCollections", Json(count))
    assert_true(survey_template_rejects(value.stringify()))
  }
  for title in ["", " leading", "trailing ", "two\nlines", "two\rlines"] {
    let value = survey_template_fixture()
    template_set(field(value, "settings"), "title", Json(title))
    assert_true(survey_template_rejects(value.stringify()))
  }
  let value = survey_template_fixture()
  let questions : Array[Json] = decode(
    field(field(value, "settings"), "questions"),
  )
  template_set(questions[0], "options", Json(["Yes", " Yes"]))
  assert_true(survey_template_rejects(value.stringify()))
  let budget = survey_budget(sample_survey(), 10000)
  assert_eq(budget.total_epsilon, 10000.0)
}

///|
test "raw survey parsing rejects duplicate and escaped duplicate keys" {
  for key in ["title", "t\\u0069tle"] {
    let source = sample_survey()
      .to_json()
      .stringify()
      .replace(old="\"title\":", new="\"\{key}\":\"secret\",\"title\":")
    let rejected = try {
      ignore(parse_survey(source))
      false
    } catch {
      KitError(message) => {
        assert_true(!message.contains("secret"))
        true
      }
    }
    assert_true(rejected)
  }
}
