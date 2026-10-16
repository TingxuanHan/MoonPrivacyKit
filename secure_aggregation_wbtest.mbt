///|
test "additive shares combine and wrap independently of the private value" {
  let a = split_aggregate([0, 17, 1000], [SHARE_MODULUS - 1, 10, 400], 1000)
  let left = decode_ints(field(a, "left"))
  let right = decode_ints(field(a, "right"))
  let total = combine_aggregate_shares(left, right, 3, 1000)
  assert_eq(total, [0, 17, 1000])
  assert_eq(sum_aggregate_shares([[SHARE_MODULUS - 1], [2]], 1), [1])
}

///|
test "three contributions reconstruct without revealing any individual share" {
  let masks = [[1, 7], [500, 3], [SHARE_MODULUS - 1, 20]]
  let values = [[2, 3], [5, 6], [7, 8]]
  let right : Array[Array[Int32]] = []
  for i in 0..<3 {
    right.push(
      decode_ints(field(split_aggregate(values[i], masks[i], 10), "right")),
    )
  }
  assert_eq(
    combine_aggregate_shares(
      sum_aggregate_shares(masks, 2),
      sum_aggregate_shares(right, 2),
      3,
      10,
    ),
    [14, 17],
  )
}
