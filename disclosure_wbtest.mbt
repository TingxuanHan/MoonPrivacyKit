///|
test "count constraints propagate to a hidden singleton" {
  let equations = [
    DisclosureEquation::{
      id: "total",
      indices: [0, 1, 2],
      total: 52,
      published: true,
    },
    { id: "a", indices: [0], total: 35, published: true, },
    { id: "b", indices: [1], total: 16, published: false, },
  ]
  let cells = ["a", "b", "c"].map(id => DisclosureCell::{
    id,
    lower: 0,
    upper: 52,
    is_protected: true,
    min_width: 5,
  })
  let result = disclosure_solve(cells, equations, 1000)
  assert_true(result.complete)
  assert_eq(result.minimum[2], 1)
  assert_eq(result.maximum[2], 1)
  assert_true(disclosure_has_risk(cells, result))
}

///|
test "integer infeasibility and resource exhaustion are different" {
  let cells = ["a", "b", "c"].map(id => DisclosureCell::{
    id,
    lower: 0,
    upper: 100,
    is_protected: true,
    min_width: 1,
  })
  let inconsistent = disclosure_solve(
    cells,
    [
      { id: "ab", indices: [0, 1], total: 1, published: true, },
      { id: "bc", indices: [1, 2], total: 1, published: true, },
      { id: "ac", indices: [0, 2], total: 1, published: true, },
    ],
    100,
  )
  assert_true(inconsistent.complete)
  assert_eq(inconsistent.solutions, 0)
  let limited = disclosure_solve(cells, [], 100)
  assert_false(limited.complete)
  assert_false(disclosure_has_risk(cells, limited))
}
