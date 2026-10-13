///|
pub struct QuestionPrecision {
  id : String
  title : String
  categories : Int32
  epsilon : Double
  radius : Double?
  required_samples : Int32?
  reason : String
  target_met : Bool
}

///|
pub extend QuestionPrecision with ToJson::{to_json}

///|
pub impl ToJson for QuestionPrecision with fn to_json(self) {
  {
    "id": Json(self.id),
    "title": Json(self.title),
    "categories": Json(self.categories),
    "epsilon": Json(self.epsilon),
    "radius": nullable_json(self.radius),
    "required_samples": nullable_json(self.required_samples),
    "reason": Json(self.reason),
    "target_met": Json(self.target_met),
  }
}

///|
pub struct SurveyAssessment {
  samples : Int32
  collections : Int32
  target_radius : Double
  confidence : Double
  single_epsilon : Double
  total_epsilon : Double
  required_samples : Int32?
  reason : String
  target_met : Bool
  questions : Array[QuestionPrecision]
}

///|
pub extend SurveyAssessment with ToJson::{to_json}

///|
pub impl ToJson for SurveyAssessment with fn to_json(self) {
  {
    "samples": Json(self.samples),
    "collections": Json(self.collections),
    "target_radius": Json(self.target_radius),
    "confidence": Json(self.confidence),
    "single_epsilon": Json(self.single_epsilon),
    "total_epsilon": Json(self.total_epsilon),
    "required_samples": nullable_json(self.required_samples),
    "reason": Json(self.reason),
    "target_met": Json(self.target_met),
    "questions": Json(self.questions),
  }
}

///|
/// Bounds cover all options of all questions in ONE collection. Repeated
/// collection changes composition, never the independent sample count.
pub fn assess_survey(
  survey : Survey,
  samples : Int32,
  target_radius : Double,
  collections~ : Int32 = 1,
) -> SurveyAssessment raise KitError {
  if samples < 1 || samples > 10000000 {
    raise KitError("sample count must be between 1 and 10000000")
  }
  if !finite(target_radius) || target_radius <= 0.0 || target_radius >= 1.0 {
    raise KitError("target error must be finite and strictly between 0 and 1")
  }
  let mechanisms = validate_survey(survey)
  let budget = survey_budget(survey, collections)
  let alpha = 0.05 / mechanisms.length().to_double()
  let questions : Array[QuestionPrecision] = []
  let mut overall_required = 1
  let mut reason = ""
  let mut target_met = true
  for index = 0; index < mechanisms.length(); index = index + 1 {
    let mechanism = mechanisms[index]
    let question = survey.questions[index]
    if mechanism.threshold == 0 {
      questions.push({
        id: question.id,
        title: question.title,
        categories: mechanism.categories,
        epsilon: question.epsilon,
        radius: None,
        required_samples: None,
        reason: "no_signal",
        target_met: false,
      })
      reason = "no_signal"
      target_met = false
    } else {
      let radius = error_radius(mechanism, samples, alpha)
      let required = required_samples(mechanism, target_radius, alpha~)
      let question_reason = match required {
        Some(count) => {
          if count > overall_required {
            overall_required = count
          }
          ""
        }
        None => {
          if reason != "no_signal" {
            reason = "above_limit"
          }
          "above_limit"
        }
      }
      let met = radius <= target_radius
      if !met {
        target_met = false
      }
      questions.push({
        id: question.id,
        title: question.title,
        categories: mechanism.categories,
        epsilon: question.epsilon,
        radius: Some(radius),
        required_samples: required,
        reason: question_reason,
        target_met: met,
      })
    }
  }
  {
    samples,
    collections,
    target_radius,
    confidence: 0.95,
    single_epsilon: budget.single_epsilon,
    total_epsilon: budget.total_epsilon,
    required_samples: if reason == "" {
      Some(overall_required)
    } else {
      None
    },
    reason,
    target_met,
    questions,
  }
}
