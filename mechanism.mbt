///|
pub suberror KitError {
  KitError(String)
}

///|
/// Size of the uniform integer gate used by mechanism version rr24-v1.
pub const GATE_SIZE : Int = 16_777_216

///|
/// Construct through make_mechanism; probabilities describe the finite sampler.
pub struct Mechanism {
  categories : Int
  threshold : Int
  requested_epsilon : Double
  effective_epsilon : Double
  truthful_probability : Double
  other_probability : Double
} derive(ToJson)

///|
fn finite(x : Double) -> Bool {
  !x.is_nan() && !x.is_inf()
}

///|
/// With threshold/GATE_SIZE probability keep the answer; otherwise choose
/// uniformly from ALL categories. One gate unit is reserved against rounding.
pub fn make_mechanism(
  categories : Int,
  epsilon : Double,
) -> Mechanism raise KitError {
  if categories < 2 || categories > 256 {
    raise KitError("category count must be between 2 and 256")
  }
  if !finite(epsilon) || epsilon < 0.0 || epsilon > 8.0 {
    raise KitError("epsilon must be finite and between 0 and 8")
  }
  let k = categories.to_double()
  let m = GATE_SIZE.to_double()
  let extra = @math.expm1(epsilon)
  let rounded = @math.floor(m * extra / (extra + k)).to_int()
  let threshold = if rounded > 0 { rounded - 1 } else { 0 }
  let a = threshold.to_double()
  let other = (m - a) / (m * k)
  let effective = @math.ln_1p(k * a / (m - a))
  if effective > epsilon {
    raise KitError("unable to construct a conservative finite mechanism")
  }
  {
    categories,
    threshold,
    requested_epsilon: epsilon,
    effective_epsilon: effective,
    truthful_probability: a / m + other,
    other_probability: other,
  }
}

///|
/// The caller must supply two INDEPENDENT uniform samples from a secure source:
/// gate in [0, GATE_SIZE), fallback in [0, categories). Never publish the samples.
pub fn randomize(
  mechanism : Mechanism,
  answer : Int,
  gate : Int,
  fallback : Int,
) -> Int raise KitError {
  if answer < 0 || answer >= mechanism.categories {
    raise KitError("answer is outside the declared category domain")
  }
  if gate < 0 ||
    gate >= GATE_SIZE ||
    fallback < 0 ||
    fallback >= mechanism.categories {
    raise KitError("random sample is outside the declared domain")
  }
  if gate < mechanism.threshold {
    answer
  } else {
    fallback
  }
}

///|
pub extend Mechanism with ToJson::{to_json}
