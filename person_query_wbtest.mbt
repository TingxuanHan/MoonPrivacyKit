///|
test "bounded sum limits all rows of the same person" {
  let request : Json = {
    "unit_ids": ["a", "a", "a", "b"],
    "values": [100, -3, 7, 8],
    "max_contributions": 2,
    "value_upper": 8,
    "epsilon": 1.0,
  }
  let (counts, mechanism, _) = prepare_sum_request(request)
  assert_eq(counts[0], 16)
  assert_eq(mechanism.max_contributions, 16)
  assert_true(mechanism.epsilon_upper_bound <= 1.0)
}

///|
test "join sensitivity follows public per-person limits" {
  let plan : Json = {
    "schema_version": 1,
    "join": "same_person_inner",
    "unit_field": "id",
    "left_cap": 3,
    "right_cap": 4,
    "output_cap": 5,
    "query": "bounded_sum",
    "value_field": "amount",
    "value_upper": 10,
  }
  let result = plan_person_query(plan)
  assert_eq(decode_int(field(result, "join_rows_per_person")), 12)
  assert_eq(decode_int(field(result, "l1_sensitivity")), 50)
}
