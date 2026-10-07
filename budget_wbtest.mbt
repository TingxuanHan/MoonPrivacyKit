///|
test "fixed precision charges exactly consume a decimal budget" {
  let state = make_budget_state(300_000, 0)
  let first = charge_budget(state, 100_000)
  let second = charge_budget(first, 200_000)
  assert_eq(state.spent_units, 0)
  assert_eq(first.remaining_units, 200_000)
  assert_eq(second.spent_units, 300_000)
  assert_eq(second.remaining_units, 0)
  let rejected = try {
    ignore(charge_budget(second, 10_000))
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}

///|
test "budget refuses corrupt state invalid charges and integer overflow" {
  for
    params in [
      (9999, 0),
      (1_000_000_001, 0),
      (1_000_000, -1),
      (1_000_000, 1_000_001),
    ] {
    let rejected = try {
      ignore(make_budget_state(params.0, params.1))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  let state = make_budget_state(1_000_000_000, 999_990_000)
  for charge in [-1, 0, 9999, 10_001, 8_000_001, 2_147_483_647] {
    let rejected = try {
      ignore(charge_budget(state, charge))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  assert_eq(charge_budget(state, 10_000).remaining_units, 0)
}

///|
test "many small charges retain exact accounting after serialization" {
  let mut state = make_budget_state(1_000_000, 0)
  for _i = 0; _i < 100; _i = _i + 1 {
    state = charge_budget(state, 10_000)
  }
  assert_eq(state.spent_units, 1_000_000)
  let result = dispatch(
    "{\"op\":\"budgetState\",\"total_units\":1000000,\"spent_units\":1000000}",
  )
  assert_true(result.contains("\"remaining_units\":0"))
  let invalid = dispatch(
    "{\"op\":\"chargeBudget\",\"total_units\":1000000,\"spent_units\":0,\"charge_units\":10000.5}",
  )
  assert_true(invalid.contains("\"ok\":false"))
}
