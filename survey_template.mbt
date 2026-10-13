///|
/// Portable questionnaire settings, without a survey or response identity.
pub struct SurveyTemplate {
  name : String
  title : String
  questions : Array[Question]
  planned_collections : Int32
}

///|
pub extend SurveyTemplate with ToJson::{to_json}

///|
pub impl ToJson for SurveyTemplate with fn to_json(self) {
  {
    "schemaVersion": 1,
    "kind": "moonprivacykit/survey-template",
    "name": Json(self.name),
    "settings": {
      "title": Json(self.title),
      "questions": Json(self.questions),
      "plannedCollections": Json(self.planned_collections),
    },
  }
}

///|
pub struct SurveyBudget {
  questions : Int32
  collections : Int32
  single_epsilon : Double
  total_epsilon : Double
} derive(ToJson)

///|
pub extend SurveyBudget with ToJson::{to_json}

///|
/// A planning bound for one person, not a record of actual participation.
pub fn survey_budget(
  survey : Survey,
  collections : Int32,
) -> SurveyBudget raise KitError {
  let mechanisms = validate_survey(survey)
  if collections < 1 || collections > 10000 {
    raise KitError("collection count must be between 1 and 10000")
  }
  let mut single_epsilon = 0.0
  for mechanism in mechanisms {
    single_epsilon = single_epsilon + mechanism.requested_epsilon
  }
  {
    questions: mechanisms.length(),
    collections,
    single_epsilon,
    total_epsilon: single_epsilon * collections.to_double(),
  }
}

///|
pub fn survey_from_template(
  template : SurveyTemplate,
  survey_id : String,
) -> Survey raise KitError {
  let survey : Survey = {
    schema_version: 1,
    id: survey_id,
    title: template.title,
    questions: template.questions,
  }
  ignore(validate_survey(survey))
  survey
}

///|
pub fn parse_survey_template(input : String) -> SurveyTemplate raise KitError {
  if input.length() > 100000 {
    raise KitError("survey template exceeds the 100000 text unit limit")
  }
  let value = read_json(input)
  reject_duplicate_table_keys(input)
  require_keys(value, ["schemaVersion", "kind", "name", "settings"])
  let kind : String = decode(field(value, "kind"))
  if decode_int(field(value, "schemaVersion")) != 1 ||
    kind != "moonprivacykit/survey-template" {
    raise KitError("unsupported survey template kind or version")
  }
  let name : String = decode(field(value, "name"))
  if name.trim().is_empty() ||
    name.length() > 80 ||
    name.contains("\n") ||
    name.contains("\r") {
    raise KitError("template name must be a single line of 1 to 80 characters")
  }
  let settings = field(value, "settings")
  require_keys(settings, ["title", "questions", "plannedCollections"])
  let survey_value : Json = {
    "schema_version": 1,
    "id": "template-preview",
    "title": field(settings, "title"),
    "questions": field(settings, "questions"),
  }
  let survey = parse_survey(survey_value.stringify())
  if survey.questions.length() > 20 {
    raise KitError("survey templates support at most 20 questions")
  }
  // The line-based editor must preserve imported text without changing labels.
  let labels = [survey.title]
  for question in survey.questions {
    labels.push(question.title)
    for option in question.options {
      labels.push(option)
    }
  }
  if labels.any(label => {
      label.contains("\n") ||
      label.contains("\r") ||
      label.trim().to_owned() != label
    }) {
    raise KitError("survey template labels must be trimmed single lines")
  }
  let collections = decode_int(field(settings, "plannedCollections"))
  ignore(survey_budget(survey, collections))
  {
    name,
    title: survey.title,
    questions: survey.questions,
    planned_collections: collections,
  }
}
