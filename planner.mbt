///|
pub struct PrivacyPlan {
  questions : Int
  collections : Int
  total_epsilon : Double
  sample_count : Int
  per_question_radius : Array[Double]
} derive(ToJson)

///|
pub extend PrivacyPlan with ToJson::{to_json}

///|
/// Sequential composition for one participant answering every question in
/// every collection. This calculation does not enforce participation limits.
pub fn plan_survey(
  mechanisms : Array[Mechanism],
  samples : Int,
  collections? : Int = 1,
  alpha? : Double = 0.05,
) -> PrivacyPlan raise KitError {
  if mechanisms.is_empty() || mechanisms.length() > 100 {
    raise KitError("a plan must contain between 1 and 100 questions")
  }
  if collections < 1 || collections > 10000 {
    raise KitError("collection count must be between 1 and 10000")
  }
  if !finite(alpha) || alpha < 0.0000001 || alpha > 0.5 {
    raise KitError("plan failure probability must be between 1e-7 and 0.5")
  }
  let mut total = 0.0
  let radii : Array[Double] = []
  // Split failure probability across questions for whole-questionnaire bounds.
  for mechanism in mechanisms {
    total = total + mechanism.requested_epsilon
    radii.push(
      error_radius(mechanism, samples, alpha / mechanisms.length().to_double()),
    )
  }
  {
    questions: mechanisms.length(),
    collections,
    total_epsilon: total * collections.to_double(),
    sample_count: samples,
    per_question_radius: radii,
  }
}

///|
/// Required sample count for a simultaneous bound on ONE question. None means
/// the requirement exceeds this prototype's 10-million-response limit.
pub fn required_samples(
  mechanism : Mechanism,
  radius : Double,
  alpha? : Double = 0.05,
) -> Int? raise KitError {
  if !finite(radius) || radius <= 0.0 || radius >= 1.0 {
    raise KitError("target error must be finite and strictly between 0 and 1")
  }
  let unit_radius = error_radius(mechanism, 1, alpha)
  let n = @math.ceil(unit_radius * unit_radius / (radius * radius))
  if n > 10000000.0 {
    None
  } else {
    Some(n.to_int())
  }
}
