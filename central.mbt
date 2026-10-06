///|
/// Public input and output bound, independent of a particular dataset.
pub const CENTRAL_RECORD_LIMIT : Int = 100_000

///|
/// Construct through make_central_mechanism. All fields depend on public settings.
pub struct CentralMechanism {
  category_count : Int
  requested_epsilon : Double
  max_contributions : Int
  threshold : Int
  epsilon_upper_bound : Double
  absolute_error_bound : Int
} derive(ToJson)

///|
/// One fresh release. counts contains only noisy, bounded statistics.
pub struct CentralRelease {
  schema_version : Int
  mechanism : String
  query : String
  adjacency : String
  epsilon : Double
  epsilon_upper_bound : Double
  max_contributions : Int
  category_count : Int
  output_upper : Int
  confidence : Double
  absolute_error_bound : Int
  counts : Array[Int]
} derive(ToJson)

///|
/// Calibrate rational geometric noise conservatively for add/remove-user DP.
/// For p=t/M, C * -ln(1-p) <= C*p/(1-p) <= epsilon.
pub fn make_central_mechanism(
  category_count : Int,
  epsilon : Double,
  max_contributions : Int,
) -> CentralMechanism raise KitError {
  if category_count < 1 || category_count > 256 {
    raise KitError("category count must be between 1 and 256")
  }
  if !finite(epsilon) || epsilon < 0.01 || epsilon > 8.0 {
    raise KitError("central epsilon must be finite and between 0.01 and 8")
  }
  if max_contributions < 1 || max_contributions > 32 {
    raise KitError("max contributions must be between 1 and 32")
  }
  let m = GATE_SIZE.to_double()
  let c = max_contributions.to_double()
  let threshold = @math.floor(m * epsilon / (c + epsilon)).to_int() - 1
  let t = threshold.to_double()
  let upper = c * t / (m - t)
  if threshold < 1 || threshold >= GATE_SIZE || upper > epsilon {
    raise KitError("unable to construct a conservative central mechanism")
  }
  // Union bound for all bins: P(any |noise| > r) <= 2*k*exp(-p*r).
  let radius = (@math.ceil(
    @math.ln(2.0 * category_count.to_double() / 0.05) * m / t,
  ) +
  1.0).to_int()
  {
    category_count,
    requested_epsilon: epsilon,
    max_contributions,
    threshold,
    epsilon_upper_bound: upper,
    absolute_error_bound: if radius > CENTRAL_RECORD_LIMIT {
      CENTRAL_RECORD_LIMIT
    } else {
      radius
    },
  }
}

///|
fn central_draw(random_below : (Int) -> Int, size : Int) -> Int raise KitError {
  let value = random_below(size)
  let numeric = value.to_double()
  if !finite(numeric) ||
    @math.floor(numeric) != numeric ||
    value < 0 ||
    value >= size {
    raise KitError("random sample is outside the declared domain")
  }
  value
}

///|
/// Sample clamp(value + Z, 0, upper) without truncating the geometric tail.
/// On reaching a public boundary, all remaining tail mass maps to that boundary.
fn central_sample(
  value : Int,
  threshold : Int,
  gate_size : Int,
  upper : Int,
  random_below : (Int) -> Int,
) -> Int raise KitError {
  let start = central_draw(random_below, 2 * gate_size - threshold)
  if start < threshold {
    return value
  }
  let step = if start < gate_size { -1 } else { 1 }
  let mut result = value + step
  while result > 0 && result < upper {
    if central_draw(random_below, gate_size) < threshold {
      return result
    }
    result = result + step
  }
  if result <= 0 {
    0
  } else {
    upper
  }
}

///|
/// Validate every row, including rows beyond the contribution cap. These counts
/// remain private to the trusted holder and are never returned by a public API.
fn central_bounded_counts(
  unit_ids : Array[String],
  category_ids : Array[Int],
  mechanism : CentralMechanism,
) -> Array[Int] raise KitError {
  if unit_ids.length() > CENTRAL_RECORD_LIMIT ||
    unit_ids.length() != category_ids.length() {
    raise KitError(
      "central input arrays must match and contain at most 100000 records",
    )
  }
  let used : Map[String, Int] = Map([])
  let counts = Array::make(mechanism.category_count, 0)
  for i = 0; i < unit_ids.length(); i = i + 1 {
    let id = unit_ids[i]
    let category = category_ids[i]
    if id.length() < 1 || id.length() > 128 {
      raise KitError(
        "privacy unit identifiers must contain 1 to 128 characters",
      )
    }
    if category < 0 || category >= mechanism.category_count {
      raise KitError("category is outside the predefined domain")
    }
    let previous = match used.get(id) {
      Some(n) => n
      None => 0
    }
    if previous < mechanism.max_contributions {
      used.set(id, previous + 1)
      counts[category] = counts[category] + 1
    }
  }
  counts
}

///|
fn central_release(
  counts : Array[Int],
  mechanism : CentralMechanism,
  query : String,
  random_below : (Int) -> Int,
) -> CentralRelease raise KitError {
  let noisy = counts.map(count => {
    central_sample(
      count,
      mechanism.threshold,
      GATE_SIZE,
      CENTRAL_RECORD_LIMIT,
      random_below,
    )
  })
  {
    schema_version: 1,
    mechanism: "central-geometric24-v1",
    query,
    adjacency: "add_remove_user",
    epsilon: mechanism.requested_epsilon,
    epsilon_upper_bound: mechanism.epsilon_upper_bound,
    max_contributions: mechanism.max_contributions,
    category_count: mechanism.category_count,
    output_upper: CENTRAL_RECORD_LIMIT,
    confidence: 0.95,
    absolute_error_bound: mechanism.absolute_error_bound,
    counts: noisy,
  }
}

///|
/// Count bounded records. With max_contributions=1, count distinct privacy units.
/// Every callback invocation MUST be an independent secure uniform integer in
/// [0, size). Repeating this function spends a fresh epsilon, even on the same data.
pub fn central_count(
  unit_ids : Array[String],
  mechanism : CentralMechanism,
  random_below : (Int) -> Int,
) -> CentralRelease raise KitError {
  if mechanism.category_count != 1 {
    raise KitError("count requires a mechanism with one category")
  }
  if unit_ids.length() > CENTRAL_RECORD_LIMIT {
    raise KitError(
      "central input arrays must match and contain at most 100000 records",
    )
  }
  let counts = central_bounded_counts(
    unit_ids,
    Array::make(unit_ids.length(), 0),
    mechanism,
  )
  central_release(counts, mechanism, "count", random_below)
}

///|
/// Categories and their meaning must be fixed publicly before reading the data.
/// The cap applies across ALL bins for each stable privacy-unit identifier.
pub fn central_histogram(
  unit_ids : Array[String],
  category_ids : Array[Int],
  mechanism : CentralMechanism,
  random_below : (Int) -> Int,
) -> CentralRelease raise KitError {
  let counts = central_bounded_counts(unit_ids, category_ids, mechanism)
  central_release(counts, mechanism, "histogram", random_below)
}

///|
pub extend CentralMechanism with ToJson::{to_json}

///|
pub extend CentralRelease with ToJson::{to_json}
