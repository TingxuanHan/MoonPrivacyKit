///|
/// Additive shares over Z/(2^24). With at most 1000 participants and per-client
/// values <=1000, honest sums never wrap. This is not a malicious-input proof.
pub const SHARE_MODULUS : Int32 = 16_777_216

///|
pub fn validate_aggregate_config(value : Json) -> Json raise KitError {
  require_keys(value, [
    "schema_version", "task_id", "participants", "dimensions", "value_upper",
  ])
  let version = decode_int(field(value, "schema_version"))
  let id : String = decode(field(value, "task_id"))
  let participants : Array[String] = decode(field(value, "participants"))
  let dimensions = decode_int(field(value, "dimensions"))
  let upper = decode_int(field(value, "value_upper"))
  if version != 1 ||
    id.length() < 1 ||
    id.length() > 80 ||
    participants.length() < 3 ||
    participants.length() > 1000 ||
    dimensions < 1 ||
    dimensions > 16 ||
    upper < 1 ||
    upper > 1000 {
    raise KitError(
      "aggregate configuration requires 3 to 1000 participants, 1 to 16 dimensions and upper bound 1 to 1000",
    )
  }
  let seen : Map[String, Bool] = Map([])
  for participant in participants {
    if participant.length() < 1 ||
      participant.length() > 80 ||
      seen.contains(participant) {
      raise KitError("aggregate participant IDs must be distinct and nonempty")
    }
    seen[participant] = true
  }
  value
}

///|
pub fn split_aggregate(
  values : Array[Int32],
  masks : Array[Int32],
  upper : Int32,
) -> Json raise KitError {
  if values.length() < 1 ||
    values.length() > 16 ||
    values.length() != masks.length() ||
    upper < 1 ||
    upper > 1000 {
    raise KitError("invalid aggregate vector dimensions")
  }
  let right : Array[Int32] = []
  for i in 0..<values.length() {
    if values[i] < 0 ||
      values[i] > upper ||
      masks[i] < 0 ||
      masks[i] >= SHARE_MODULUS {
      raise KitError(
        "aggregate value or uniform mask outside the declared domain",
      )
    }
    right.push((values[i] - masks[i] + SHARE_MODULUS) % SHARE_MODULUS)
  }
  { "left": Json(masks), "right": Json(right) }
}

///|
pub fn sum_aggregate_shares(
  vectors : Array[Array[Int32]],
  dimensions : Int32,
) -> Array[Int32] raise KitError {
  if dimensions < 1 ||
    dimensions > 16 ||
    vectors.length() < 1 ||
    vectors.length() > 1000 {
    raise KitError("invalid aggregate share batch")
  }
  let total = Array::make(dimensions, 0)
  for vector in vectors {
    if vector.length() != dimensions {
      raise KitError("aggregate shares have inconsistent dimensions")
    }
    for i in 0..<dimensions {
      if vector[i] < 0 || vector[i] >= SHARE_MODULUS {
        raise KitError("invalid aggregate share field element")
      }
      total[i] = (total[i] + vector[i]) % SHARE_MODULUS
    }
  }
  total
}

///|
pub fn combine_aggregate_shares(
  left : Array[Int32],
  right : Array[Int32],
  participants : Int32,
  upper : Int32,
) -> Array[Int32] raise KitError {
  if participants < 3 || participants > 1000 || upper < 1 || upper > 1000 {
    raise KitError("invalid aggregate reconstruction bound")
  }
  let total = sum_aggregate_shares([left, right], left.length())
  if total.any(value => value > participants * upper) {
    raise KitError("aggregate result violates the public total bound")
  }
  total
}
