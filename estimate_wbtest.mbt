///|
test "balanced binary observations estimate equal proportions" {
  let result = estimate(make_mechanism(2, 1.0), [5000, 5000])
  assert_eq(result.samples, 10000)
  for row in result.categories {
    assert_true((row.raw_proportion - 0.5).abs() < 1.0e-12)
    assert_true(row.lower < 0.5 && row.upper > 0.5)
  }
  assert_true(result.informative)
}

///|
test "more samples narrow bounds and simultaneous coverage costs precision" {
  let m = make_mechanism(3, 1.0)
  let small = error_radius(m, 100, 0.05)
  let large = error_radius(m, 400, 0.05)
  assert_true((small / large - 2.0).abs() < 1.0e-12)
  assert_true(error_radius(m, 100, 0.01) > small)
  assert_true(!estimate(m, [1, 0, 0]).informative)
}

///|
test "preserve out of range unbiased estimates while clipping presentation" {
  let result = estimate(make_mechanism(2, 1.0), [100, 0])
  assert_true(result.categories[0].raw_proportion > 1.0)
  assert_true(result.categories[1].raw_proportion < 0.0)
  assert_eq(result.categories[0].display_proportion, 1.0)
  assert_eq(result.categories[1].display_proportion, 0.0)
}

///|
test "reject empty negative oversized and mismatched count vectors" {
  let m = make_mechanism(2, 1.0)
  for counts in [[0, 0], [-1, 10], [1], [10000000, 1]] {
    let rejected = try {
      ignore(estimate(m, counts))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  let rejected = try {
    ignore(estimate(make_mechanism(2, 0.0), [1, 1]))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  for alpha in [0.0, 0.51, 0.0 / 0.0, 1.0 / 0.0] {
    let rejected = try {
      ignore(estimate(m, [1, 1], alpha~))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
