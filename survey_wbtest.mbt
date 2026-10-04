///|
fn sample_survey() -> Survey {
  {
    schema_version: 1,
    id: "team-feedback",
    title: "Team feedback",
    questions: [
      { id: "q1", title: "Satisfied?", options: ["Yes", "No"], epsilon: 1.0, },
    ],
  }
}

///|
let test_fingerprint : String = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

///|
test "protected response round trip only contains the allowlisted payload" {
  let survey = parse_survey(sample_survey().to_json().stringify())
  let response = protect_response(
    survey,
    test_fingerprint,
    "0123456789abcdef0123456789abcdef",
    [1],
    [GATE_SIZE - 1],
    [0],
  )
  let encoded = response.to_json().stringify()
  let decoded = parse_response(encoded)
  assert_eq(decoded.answers, [0])
  require_keys(read_json(encoded), [
    "schema_version", "mechanism", "survey_fingerprint", "response_id", "answers",
  ])
}

///|
test "retry files are deduplicated and changed survey fingerprints rejected" {
  let survey = sample_survey()
  let r = protect_response(
    survey,
    test_fingerprint,
    "0123456789abcdef0123456789abcdef",
    [1],
    [0],
    [0],
  )
  let report = aggregate_responses(survey, test_fingerprint, [r, r])
  assert_eq(report.accepted, 1)
  assert_eq(report.duplicates, 1)
  assert_eq(report.questions[0].statistics.samples, 1)
  let wrong = try {
    ignore(
      aggregate_responses(
        survey,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [r],
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(wrong)
}

///|
test "conflicting retry content is not silently accepted" {
  let survey = sample_survey()
  let r1 = protect_response(
    survey,
    test_fingerprint,
    "0123456789abcdef0123456789abcdef",
    [0],
    [0],
    [0],
  )
  let r2 = protect_response(
    survey,
    test_fingerprint,
    r1.response_id,
    [1],
    [0],
    [0],
  )
  let rejected = try {
    ignore(aggregate_responses(survey, test_fingerprint, [r1, r2]))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}

///|
test "unknown response fields and malformed survey schemas fail closed" {
  let r = protect_response(
    sample_survey(),
    test_fingerprint,
    "0123456789abcdef0123456789abcdef",
    [0],
    [0],
    [0],
  )
  let extra = r
    .to_json()
    .stringify()
    .replace(old="\"answers\"", new="\"raw_answer\":1,\"answers\"")
  let rejected = try {
    ignore(parse_response(extra))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  for input in ["{}", "null", "invalid", "{\"schema_version\":2}"] {
    let bad = try {
      ignore(parse_survey(input))
      false
    } catch {
      _ => true
    }
    assert_true(bad)
  }
}

///|
test "duplicate question identifiers and blank options are rejected" {
  let s = sample_survey()
  let duplicate = { ..s, questions: [s.questions[0], s.questions[0]], }
  let rejected = try {
    ignore(validate_survey(duplicate))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  let blank = { ..s, questions: [{ ..s.questions[0], options: ["", "No"], }], }
  let rejected = try {
    ignore(validate_survey(blank))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}
