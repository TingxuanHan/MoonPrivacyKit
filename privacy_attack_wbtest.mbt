///|
test "Wilson intervals retain uncertainty for zero and complete success" {
  let (lo, hi) = attack_interval(0, 10, 1.959963984540054)
  assert_true(lo.abs() < 0.000000001)
  assert_true((hi - 0.2775327998628892).abs() < 0.000000001)
  let (full_lo, full_hi) = attack_interval(10, 10, 1.959963984540054)
  assert_true((full_hi - 1.0).abs() < 0.000000001)
  assert_true((full_lo + hi - 1.0).abs() < 0.000000001)
  let (middle_lo, middle_hi) = attack_interval(5, 10, 1.959963984540054)
  assert_true((middle_lo + middle_hi - 1.0).abs() < 0.000000001)
}

///|
test "attribute ties use declared category order and never the hidden truth" {
  let released : Array[AttackRow] = [
    { features: ["a"], label: 1, },
    { features: ["a"], label: 0, },
    { features: ["b"], label: 1, },
  ]
  assert_eq(attack_predict({ features: ["a"], label: 1, }, released, 2), 0)
  assert_eq(attack_predict({ features: ["a"], label: 0, }, released, 2), 0)
  assert_eq(attack_predict({ features: ["b"], label: 0, }, released, 2), 1)
  assert_eq(attack_score({ features: ["b"], label: 0, }, released), 1)
}

///|
test "shuffle is reproducible and retains a complete partition at both seed boundaries" {
  for seed in [1, 20261018, 2147483646] {
    let first = Array::makei(41, i => ({ features: [], label: i, } : AttackRow))
    let second = first.copy()
    attack_shuffle(first, seed)
    attack_shuffle(second, seed)
    assert_eq(first.map(row => row.label), second.map(row => row.label))
    let labels = first.map(row => row.label)
    labels.sort()
    assert_eq(labels, Array::makei(41, i => i))
  }
}

///|
test "copying categorical members is detected with an independent test partition" {
  let config : Json = {
    "schema_version": 1,
    "unit_field": "person",
    "known_fields": ["group"],
    "sensitive_field": "choice",
    "sensitive_values": ["yes", "no"],
    "split_seed": 1,
  }
  let members : Array[Json] = []
  let controls : Array[Json] = []
  let released : Array[Json] = []
  for i in 0..<20 {
    let feature = "m\{i}"
    members.push({
      "person": Json("member\{i}"),
      "group": Json(feature),
      "choice": "yes",
    })
    controls.push({
      "person": Json("control\{i}"),
      "group": Json("c\{i}"),
      "choice": "no",
    })
    released.push({ "group": Json(feature), "choice": "yes" })
  }
  let report = evaluate_privacy_attack({
    "config": config,
    "members": { "format": "json", "input": Json(Json(members).stringify()) },
    "nonmembers": {
      "format": "json",
      "input": Json(Json(controls).stringify()),
    },
    "released": { "format": "json", "input": Json(Json(released).stringify()) },
  })
  let membership = field(report, "membership")
  assert_eq(decode_int(field(membership, "threshold_mismatches")), 0)
  assert_eq(decode_int(field(membership, "true_positives")), 10)
  assert_eq(decode_int(field(membership, "false_positives")), 0)
  assert_true(!report.stringify().contains("member0"))
}
