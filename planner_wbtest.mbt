///|
test "privacy plan composes repeated collections and all questions" {
  let mechanisms = [make_mechanism(2, 1.0), make_mechanism(3, 0.5)]
  let plan = plan_survey(mechanisms, 1000, collections=3)
  assert_eq(plan.total_epsilon, 4.5)
  assert_eq(plan.questions, 2)
  assert_true(
    plan.per_question_radius[0] > error_radius(mechanisms[0], 1000, 0.05),
  )
}

///|
test "sample planning returns a sufficient minimal integer" {
  let m = make_mechanism(2, 1.0)
  let n = required_samples(m, 0.05).unwrap()
  assert_true(error_radius(m, n, 0.05) <= 0.05)
  assert_true(error_radius(m, n - 1, 0.05) > 0.05)
  assert_true(required_samples(make_mechanism(256, 0.01), 0.001) is None)
}

///|
test "invalid planning inputs fail before returning misleading precision" {
  let m = make_mechanism(2, 1.0)
  let empty = try {
    ignore(plan_survey([], 100))
    false
  } catch {
    _ => true
  }
  let repeats = try {
    ignore(plan_survey([m], 100, collections=0))
    false
  } catch {
    _ => true
  }
  assert_true(empty && repeats)
  let invalid_confidence = try {
    ignore(plan_survey([m, m], 100, alpha=1.0))
    false
  } catch {
    _ => true
  }
  assert_true(invalid_confidence)
  for radius in [0.0, -0.1, 1.0, 0.0 / 0.0] {
    let rejected = try {
      ignore(required_samples(m, radius))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
