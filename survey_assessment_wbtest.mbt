///|
fn assessment_fixture() -> Survey raise KitError {
  survey_from_template(
    parse_survey_template(survey_template_fixture().stringify()),
    "assessment",
  )
}

///|
test "mixed survey precision uses whole-questionnaire coverage and the slowest question" {
  let survey = assessment_fixture()
  let assessment = assess_survey(survey, 1000, 0.05, collections=3)
  let mechanisms = validate_survey(survey)
  let plan = plan_survey(mechanisms, 1000, collections=3)
  let mut maximum = 0
  for i = 0; i < mechanisms.length(); i = i + 1 {
    let q = assessment.questions[i]
    assert_eq(q.radius.unwrap(), plan.per_question_radius[i])
    let required = q.required_samples.unwrap()
    if required > maximum {
      maximum = required
    }
    let alpha = 0.05 / mechanisms.length().to_double()
    assert_true(error_radius(mechanisms[i], required, alpha) <= 0.05)
    assert_true(error_radius(mechanisms[i], required - 1, alpha) > 0.05)
    assert_true(q.radius.unwrap() > error_radius(mechanisms[i], 1000, 0.05))
  }
  assert_eq(assessment.required_samples.unwrap(), maximum)
  assert_eq(assessment.total_epsilon, 2.25)
  assert_eq(assessment.single_epsilon, 0.75)
  assert_true(assess_survey(survey, maximum, 0.05).target_met)
}

///|
test "repeat collections increase cost without inventing independent participants" {
  let survey = assessment_fixture()
  let once = assess_survey(survey, 1000, 0.1)
  let repeated = assess_survey(survey, 1000, 0.1, collections=10)
  assert_eq(once.required_samples, repeated.required_samples)
  assert_eq(repeated.total_epsilon, once.total_epsilon * 10.0)
  assert_eq(repeated.samples, 1000)
  for i = 0; i < once.questions.length(); i = i + 1 {
    assert_eq(once.questions[i].radius, repeated.questions[i].radius)
  }
  assert_true(
    assess_survey(survey, 10000, 0.1).questions[0].radius.unwrap() <
    once.questions[0].radius.unwrap(),
  )
}

///|
test "no-signal questions and out-of-range sample requirements remain distinct" {
  let original = sample_survey()
  for epsilon in [0.0, 0.000000000001] {
    let survey : Survey = {
      ..original,
      questions: [
        { ..original.questions[0], epsilon, },
        { ..original.questions[0], id: "other", epsilon: 0.01, },
      ],
    }
    let result = assess_survey(survey, 1000, 0.0001)
    assert_eq(result.reason, "no_signal")
    assert_eq(result.required_samples, None)
    assert_eq(result.questions[0].radius, None)
    assert_eq(result.questions[1].reason, "above_limit")
    assert_true(result.questions[1].radius is Some(_))
    assert_true(!result.target_met)
  }
  let limited : Survey = {
    ..original,
    questions: [{ ..original.questions[0], epsilon: 0.01, }],
  }
  assert_eq(assess_survey(limited, 10000000, 0.0001).reason, "above_limit")
}

///|
test "invalid assessment dimensions fail before a result is emitted" {
  let survey = sample_survey()
  for samples in [0, -1, 10000001] {
    let rejected = try {
      ignore(assess_survey(survey, samples, 0.05))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  for radius in [0.0, -1.0, 1.0, 0.0 / 0.0, 1.0 / 0.0] {
    let rejected = try {
      ignore(assess_survey(survey, 1000, radius))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  for collections in [0, 10001] {
    let rejected = try {
      ignore(assess_survey(survey, 1000, 0.05, collections~))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
