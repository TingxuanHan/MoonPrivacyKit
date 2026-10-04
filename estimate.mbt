///|
pub struct CategoryEstimate {
  category : Int
  reported_count : Int
  raw_proportion : Double
  display_proportion : Double
  lower : Double
  upper : Double
} derive(ToJson)

///|
pub extend CategoryEstimate with ToJson::{to_json}

///|
pub struct Estimate {
  samples : Int
  confidence : Double
  simultaneous_radius : Double
  informative : Bool
  categories : Array[CategoryEstimate]
} derive(ToJson)

///|
pub extend Estimate with ToJson::{to_json}

///|
fn clamp_proportion(x : Double) -> Double {
  if x < 0.0 {
    0.0
  } else if x > 1.0 {
    1.0
  } else {
    x
  }
}

///|
/// Hoeffding bound with a union bound across all categories of ONE question.
/// It assumes independent randomization. It is not a survey-bias correction.
pub fn error_radius(
  mechanism : Mechanism,
  samples : Int,
  alpha : Double,
) -> Double raise KitError {
  if samples < 1 || samples > 10_000_000 {
    raise KitError("sample count must be between 1 and 10000000")
  }
  if !finite(alpha) || alpha < 0.000000001 || alpha > 0.5 {
    raise KitError("failure probability must be between 1e-9 and 0.5")
  }
  let signal = mechanism.threshold.to_double() / GATE_SIZE.to_double()
  if signal <= 0.0 {
    raise KitError(
      "this mechanism contains no signal for proportion estimation",
    )
  }
  Double::sqrt(
    @math.ln(2.0 * mechanism.categories.to_double() / alpha) /
    (2.0 * samples.to_double()),
  ) /
  signal
}

///|
/// Raw proportions are unbiased; display proportions and intervals are clipped
/// to [0, 1]. Clipped category estimates need not sum to one.
pub fn estimate(
  mechanism : Mechanism,
  counts : Array[Int],
  alpha? : Double = 0.05,
) -> Estimate raise KitError {
  if counts.length() != mechanism.categories {
    raise KitError("count vector must match the category domain")
  }
  let mut samples = 0
  for count in counts {
    if count < 0 || count > 10_000_000 - samples {
      raise KitError("counts must be nonnegative and total at most 10000000")
    }
    samples = samples + count
  }
  let radius = error_radius(mechanism, samples, alpha)
  let signal = mechanism.threshold.to_double() / GATE_SIZE.to_double()
  let rows : Array[CategoryEstimate] = []
  for i = 0; i < counts.length(); i = i + 1 {
    let raw = (
        counts[i].to_double() / samples.to_double() -
        mechanism.other_probability
      ) /
      signal
    rows.push({
      category: i,
      reported_count: counts[i],
      raw_proportion: raw,
      display_proportion: clamp_proportion(raw),
      lower: clamp_proportion(raw - radius),
      upper: clamp_proportion(raw + radius),
    })
  }
  {
    samples,
    confidence: 1.0 - alpha,
    simultaneous_radius: radius,
    informative: radius < 0.5,
    categories: rows,
  }
}
