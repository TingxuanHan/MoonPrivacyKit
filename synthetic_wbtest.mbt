///|
fn synthetic_test_plan(rows : Int32) -> Json {
  {
    "schema_version": 1,
    "unit_field": "person",
    "output_rows": Json(rows),
    "fields": [
      { "name": "group", "categories": ["a", "b"], "parent": -1 },
      { "name": "choice", "categories": ["yes", "no"], "parent": 0 },
    ],
  }
}

///|
test "synthetic concatenation has person-level L1 sensitivity equal to field count" {
  let plan = synthetic_test_plan(2)
  let explanation = plan_synthetic(plan)
  assert_eq(decode_int(field(explanation, "measurement_cells")), 6)
  assert_eq(decode_int(field(explanation, "l1_sensitivity")), 2)
  let mapped = map_synthetic(
    plan, "csv", "person,group,choice\nx,a,no\ny,b,yes\n",
  )
  assert_eq(decode_ints(field(mapped, "category_ids")), [0, 3, 1, 4])
  let smaller = map_synthetic(plan, "csv", "person,group,choice\nx,a,no\n")
  let mechanism = make_central_mechanism(6, 1.0, 2)
  let left = central_bounded_counts(
    decode(field(mapped, "unit_ids")),
    decode_ints(field(mapped, "category_ids")),
    mechanism,
  )
  let right = central_bounded_counts(
    decode(field(smaller, "unit_ids")),
    decode_ints(field(smaller, "category_ids")),
    mechanism,
  )
  let mut difference = 0
  for i in 0..<6 {
    difference = difference + (left[i] - right[i]).abs()
  }
  assert_eq(difference, 2)
}

///|
test "synthetic sampling uses selected parent conditional and exact integer weights" {
  // Root weights 10:1; a -> yes weights 1:10; b -> yes weights 10:1.
  let counts = [9, 0, 0, 9, 9, 0]
  let draws = [0, 1, 10, 0]
  let mut cursor = 0
  let output = synthetic_sample(synthetic_test_plan(2), counts, size => {
    assert_eq(size, 11) catch {
      _ => abort("wrong conditional weight")
    }
    let value = draws[cursor]
    cursor = cursor + 1
    value
  })
  let rows : Array[Array[String]] = decode(field(output, "rows"))
  assert_eq(rows, [["a", "no"], ["b", "yes"]])
  assert_eq(cursor, 4)
}

///|
test "empty protected cells still define a public-only smoothed distribution" {
  let output = synthetic_sample(synthetic_test_plan(1), [0, 0, 0, 0, 0, 0], n => {
    n - 1
  })
  let rows : Array[Array[String]] = decode(field(output, "rows"))
  assert_eq(rows, [["b", "no"]])
}

///|
test "synthetic CSV quotes and neutralizes formula labels without changing JSON labels" {
  let plan : Json = {
    "schema_version": 1,
    "unit_field": "person",
    "output_rows": 1,
    "fields": [
      { "name": "=field", "categories": ["=value,\"quoted\""], "parent": -1 },
    ],
  }
  let output = synthetic_sample(plan, [0], _ => {
    abort("single option must not draw")
  })
  assert_eq(decode_int(field(output, "csv_escaped_cells")), 2)
  let rows : Array[Array[String]] = decode(field(output, "rows"))
  assert_eq(rows, [["=value,\"quoted\""]])
  let csv : String = decode(field(output, "csv"))
  assert_eq(csv, "\"'=field\"\r\n\"'=value,\"\"quoted\"\"\"\r\n")
}
