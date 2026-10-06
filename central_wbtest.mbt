///|
test "central calibration is conservative across supported settings" {
  for epsilon in [0.01, 0.1, 1.0, 8.0] {
    for cap in [1, 2, 32] {
      for categories in [1, 3, 256] {
        let m = make_central_mechanism(categories, epsilon, cap)
        let p = m.threshold.to_double() / GATE_SIZE.to_double()
        let exact = -cap.to_double() * @math.ln_1p(-p)
        assert_true(exact <= m.epsilon_upper_bound)
        assert_true(m.epsilon_upper_bound <= epsilon)
        assert_true(m.threshold > 0 && m.threshold < GATE_SIZE)
        assert_true(m.absolute_error_bound >= 1)
        assert_true(m.absolute_error_bound <= CENTRAL_RECORD_LIMIT)
        assert_true(
          2.0 *
          categories.to_double() *
          @math.exp(-p * m.absolute_error_bound.to_double()) <=
          0.05,
        )
      }
    }
  }
}

///|
test "central rejects unsupported budgets and dimensions" {
  for epsilon in [0.0, -1.0, 0.009, 8.01, 0.0 / 0.0, 1.0 / 0.0] {
    let rejected = try {
      ignore(make_central_mechanism(1, epsilon, 1))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  for params in [(0, 1), (257, 1), (1, 0), (1, 33)] {
    let rejected = try {
      ignore(make_central_mechanism(params.0, 1.0, params.1))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
test "central cap groups repeated units across histogram bins" {
  let ids = ["a", "b", "a", "a", "b", "c"]
  let categories = [0, 2, 1, 2, 0, 1]
  let m = make_central_mechanism(3, 1.0, 2)
  assert_eq(central_bounded_counts(ids, categories, m), [2, 2, 1])
  let histogram = central_histogram(ids, categories, m, _ => 0)
  assert_eq(histogram.counts, [2, 2, 1])
  assert_eq(histogram.query, "histogram")
  assert_eq(
    central_count(ids, make_central_mechanism(1, 1.0, 1), _ => 0).counts,
    [3],
  )
  assert_eq(
    central_count(ids, make_central_mechanism(1, 1.0, 2), _ => 0).counts,
    [5],
  )
}

///|
test "removing a whole privacy unit changes at most C contributions" {
  let ids = ["a", "b", "a", "c", "a", "c", "b"]
  let bins = [0, 1, 2, 1, 0, 0, 2]
  for cap in [1, 2, 3] {
    let m = make_central_mechanism(3, 1.0, cap)
    let full = central_bounded_counts(ids, bins, m)
    for omitted in ["a", "b", "c"] {
      let remaining_ids : Array[String] = []
      let remaining_bins : Array[Int] = []
      for i = 0; i < ids.length(); i = i + 1 {
        if ids[i] != omitted {
          remaining_ids.push(ids[i])
          remaining_bins.push(bins[i])
        }
      }
      let reduced = central_bounded_counts(remaining_ids, remaining_bins, m)
      let mut distance = 0
      for i = 0; i < full.length(); i = i + 1 {
        assert_true(full[i] >= reduced[i])
        distance += full[i] - reduced[i]
      }
      assert_true(distance <= cap)
    }
  }
}

///|
test "empty data still randomizes every public histogram category" {
  let m = make_central_mechanism(4, 1.0, 1)
  let mut draws = 0
  let report = central_histogram([], [], m, _ => {
    draws += 1
    m.threshold
  })
  assert_eq(draws, 4)
  assert_eq(report.counts, [0, 0, 0, 0])
  assert_eq(report.output_upper, CENTRAL_RECORD_LIMIT)
  assert_eq(report.epsilon, 1.0)
}

///|
test "central validates all records before drawing randomness" {
  let m = make_central_mechanism(2, 1.0, 1)
  let mut draws = 0
  for pair in [(["a"], []), ([""], [0]), (["a", "a"], [0, 2]), (["a"], [-1])] {
    let rejected = try {
      ignore(
        central_histogram(pair.0, pair.1, m, _ => {
          draws += 1
          0
        }),
      )
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  assert_eq(draws, 0)
  let too_many = try {
    ignore(
      central_count(
        Array::make(CENTRAL_RECORD_LIMIT + 1, "a"),
        make_central_mechanism(1, 1.0, 1),
        _ => 0,
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(too_many)
  let wrong_mechanism = try {
    ignore(central_count([], m, _ => 0))
    false
  } catch {
    _ => true
  }
  assert_true(wrong_mechanism)
}

///|
test "geometric sampler follows zero sign and continuation branches" {
  assert_eq(central_sample(2, 1, 4, 4, _ => 0), 2)
  let mut calls = 0
  assert_eq(
    central_sample(2, 1, 4, 4, _ => {
      calls += 1
      if calls == 1 {
        1
      } else {
        0
      }
    }),
    1,
  )
  calls = 0
  assert_eq(
    central_sample(2, 1, 4, 4, _ => {
      calls += 1
      if calls == 1 {
        4
      } else {
        0
      }
    }),
    3,
  )
  assert_eq(central_sample(2, 1, 4, 4, _ => 1), 0)
  assert_eq(central_sample(0, 1, 4, 4, _ => 1), 0)
  assert_eq(central_sample(4, 1, 4, 4, size => size - 1), 4)
  calls = 0
  assert_eq(
    central_sample(0, 1, 4, 4, size => {
      calls += 1
      size - 1
    }),
    4,
  )
  assert_eq(calls, 4)
}

///|
test "geometric sampler rejects invalid random integers" {
  for invalid in [-1, 7] {
    let rejected = try {
      ignore(central_sample(2, 1, 4, 4, _ => invalid))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
// Exhaust all initial draws and three later base-4 draws. Unused suffixes are
// included with their probability, testing tail accumulation at both bounds.
fn small_sampler_distribution(value : Int) -> Array[Double] raise KitError {
  let probabilities = Array::make(5, 0.0)
  for first = 0; first < 7; first = first + 1 {
    for suffix = 0; suffix < 64; suffix = suffix + 1 {
      let mut index = 0
      let mut rest = suffix
      let output = central_sample(value, 1, 4, 4, _ => {
        let draw = if index == 0 {
          first
        } else {
          let v = rest % 4
          rest = rest / 4
          v
        }
        index += 1
        draw
      })
      probabilities[output] += 1.0 / (7.0 * 64.0)
    }
  }
  probabilities
}

///|
test "exhaustive clipped sampler matches infinite geometric law and DP ratios" {
  let q = 0.75
  let distributions = [0, 1, 2, 3, 4].map(value => {
    small_sampler_distribution(value)
  })
  for value = 0; value <= 4; value = value + 1 {
    let mut total = 0.0
    for output = 0; output <= 4; output = output + 1 {
      let probability = distributions[value][output]
      total += probability
      let distance = (output - value).to_double().abs()
      let expected = if output == 0 || output == 4 {
        @math.pow(q, distance) / (1.0 + q)
      } else {
        (1.0 - q) / (1.0 + q) * @math.pow(q, distance)
      }
      assert_true((probability - expected).abs() < 0.000000001)
      if value < 4 {
        let neighbor = distributions[value + 1][output]
        assert_true(probability / neighbor <= 1.0 / q + 0.000000001)
        assert_true(neighbor / probability <= 1.0 / q + 0.000000001)
      }
    }
    assert_true((total - 1.0).abs() < 0.000000001)
  }
}

///|
test "central error bounds respond to budget cap and number of categories" {
  let base = make_central_mechanism(1, 1.0, 1).absolute_error_bound
  assert_true(make_central_mechanism(1, 0.1, 1).absolute_error_bound > base)
  assert_true(make_central_mechanism(1, 1.0, 2).absolute_error_bound > base)
  assert_true(make_central_mechanism(256, 1.0, 1).absolute_error_bound > base)
}
