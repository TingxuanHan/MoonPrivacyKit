///|
test "finite mechanisms normalize and stay below the requested privacy loss" {
  for k in [2, 3, 5, 32, 256] {
    for epsilon in [0.0, 0.000001, 0.1, 1.0, 4.0, 8.0] {
      let m = make_mechanism(k, epsilon)
      let total = m.truthful_probability +
        (k - 1).to_double() * m.other_probability
      assert_true((total - 1.0).abs() < 1.0e-12)
      assert_true(m.other_probability > 0.0)
      assert_true(m.effective_epsilon <= epsilon)
      assert_true(m.threshold >= 0 && m.threshold < GATE_SIZE)
      let log_ratio = @math.ln(m.truthful_probability / m.other_probability)
      assert_true((log_ratio - m.effective_epsilon).abs() < 1.0e-12)
    }
  }
}

///|
test "integer sampler covers threshold edges and every category" {
  let m = make_mechanism(3, 1.0)
  for answer = 0; answer < 3; answer = answer + 1 {
    for fallback = 0; fallback < 3; fallback = fallback + 1 {
      assert_eq(randomize(m, answer, 0, fallback), answer)
      assert_eq(randomize(m, answer, m.threshold - 1, fallback), answer)
      assert_eq(randomize(m, answer, m.threshold, fallback), fallback)
      assert_eq(randomize(m, answer, GATE_SIZE - 1, fallback), fallback)
    }
  }
}

///|
test "zero privacy loss removes all dependence on the answer" {
  let m = make_mechanism(2, 0.0)
  for answer in [0, 1] {
    assert_eq(randomize(m, answer, 0, 1), 1)
    assert_eq(randomize(m, answer, GATE_SIZE - 1, 0), 0)
  }
  assert_eq(m.effective_epsilon, 0.0)
}

///|
test "reject invalid parameters and random inputs without revealing values" {
  for
    (k, e) in [
      (1, 1.0),
      (257, 1.0),
      (2, -0.1),
      (2, 8.1),
      (2, 0.0 / 0.0),
      (2, 1.0 / 0.0),
    ] {
    let rejected = try {
      ignore(make_mechanism(k, e))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  let m = make_mechanism(2, 1.0)
  for
    (a, g, f) in [
      (-1, 0, 0),
      (2, 0, 0),
      (0, -1, 0),
      (0, GATE_SIZE, 0),
      (0, 0, 2),
    ] {
    let rejected = try {
      ignore(randomize(m, a, g, f))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
