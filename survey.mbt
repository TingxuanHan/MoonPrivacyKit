///|
pub(all) struct Question {
  id : String
  title : String
  options : Array[String]
  epsilon : Double
} derive(ToJson, @json.FromJson)

///|
pub extend Question with ToJson::{to_json}

///|
pub(all) struct Survey {
  schema_version : Int
  id : String
  title : String
  questions : Array[Question]
} derive(ToJson, @json.FromJson)

///|
pub extend Survey with ToJson::{to_json}

///|
pub struct ProtectedResponse {
  schema_version : Int
  mechanism : String
  survey_fingerprint : String
  response_id : String
  answers : Array[Int]
} derive(ToJson, @json.FromJson)

///|
pub extend ProtectedResponse with ToJson::{to_json}

///|
fn safe_id(id : String) -> Bool {
  id.length() > 0 &&
  id.length() <= 64 &&
  id
  .iter()
  .all(fn(c) {
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c == '_' ||
    c == '-'
  })
}

///|
fn hex_id(id : String, length : Int) -> Bool {
  id.length() == length &&
  id.iter().all(fn(c) { (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') })
}

///|
pub fn validate_survey(survey : Survey) -> Array[Mechanism] raise KitError {
  if survey.schema_version != 1 || !safe_id(survey.id) {
    raise KitError("unsupported survey version or invalid survey identifier")
  }
  if survey.title.trim().is_empty() || survey.title.length() > 300 {
    raise KitError("survey title must contain 1 to 300 characters")
  }
  if survey.questions.is_empty() || survey.questions.length() > 100 {
    raise KitError("a survey must contain 1 to 100 questions")
  }
  let seen : Map[String, Bool] = Map([])
  let mechanisms : Array[Mechanism] = []
  for question in survey.questions {
    if !safe_id(question.id) || seen.contains(question.id) {
      raise KitError("question identifiers must be valid and unique")
    }
    seen[question.id] = true
    if question.title.trim().is_empty() || question.title.length() > 500 {
      raise KitError("question title must contain 1 to 500 characters")
    }
    let options : Map[String, Bool] = Map([])
    for option in question.options {
      if option.trim().is_empty() ||
        option.length() > 200 ||
        options.contains(option) {
        raise KitError(
          "option labels must be nonempty, distinct and at most 200 characters",
        )
      }
      options[option] = true
    }
    mechanisms.push(make_mechanism(question.options.length(), question.epsilon))
  }
  mechanisms
}

///|
fn read_json(input : String) -> Json raise KitError {
  @json.parse(input) catch {
    _ => raise KitError("invalid JSON document")
  }
}

///|
fn require_keys(value : Json, keys : Array[String]) -> Unit raise KitError {
  match value {
    Object(fields) =>
      if fields.length() != keys.length() ||
        !keys.all(fn(k) { fields.contains(k) }) {
        raise KitError("document fields do not match the versioned schema")
      }
    _ => raise KitError("expected a JSON object")
  }
}

///|
pub fn parse_survey(input : String) -> Survey raise KitError {
  let value = read_json(input)
  require_keys(value, ["schema_version", "id", "title", "questions"])
  ignore(decode_int(field(value, "schema_version")))
  match value {
    { "questions": Array(questions), .. } =>
      for question in questions {
        require_keys(question, ["id", "title", "options", "epsilon"])
      }
    _ => raise KitError("questions must be an array")
  }
  let survey : Survey = @json.from_json(value) catch {
    _ => raise KitError("invalid survey field types")
  }
  ignore(validate_survey(survey))
  survey
}

///|
pub fn parse_response(input : String) -> ProtectedResponse raise KitError {
  let value = read_json(input)
  ignore(decode_int(field(value, "schema_version")))
  ignore(decode_ints(field(value, "answers")))
  require_keys(value, [
    "schema_version", "mechanism", "survey_fingerprint", "response_id", "answers",
  ])
  @json.from_json(value) catch {
    _ => raise KitError("invalid protected response field types")
  }
}

///|
pub fn protect_response(
  survey : Survey,
  fingerprint : String,
  response_id : String,
  answers : Array[Int],
  gates : Array[Int],
  fallbacks : Array[Int],
) -> ProtectedResponse raise KitError {
  let mechanisms = validate_survey(survey)
  if !hex_id(fingerprint, 64) || !hex_id(response_id, 32) {
    raise KitError(
      "invalid configuration fingerprint or random response identifier",
    )
  }
  let n = mechanisms.length()
  if answers.length() != n || gates.length() != n || fallbacks.length() != n {
    raise KitError(
      "answer and random sample counts must match the questionnaire",
    )
  }
  let protected_answers : Array[Int] = []
  for i = 0; i < n; i = i + 1 {
    protected_answers.push(
      randomize(mechanisms[i], answers[i], gates[i], fallbacks[i]),
    )
  }
  {
    schema_version: 1,
    mechanism: "rr24-v1",
    survey_fingerprint: fingerprint,
    response_id,
    answers: protected_answers,
  }
}

///|
pub struct QuestionResult {
  id : String
  title : String
  options : Array[String]
  statistics : Estimate
} derive(ToJson)

///|
pub extend QuestionResult with ToJson::{to_json}

///|
pub struct SurveyReport {
  survey_id : String
  accepted : Int
  duplicates : Int
  questionnaire_confidence : Double
  questions : Array[QuestionResult]
} derive(ToJson)

///|
pub extend SurveyReport with ToJson::{to_json}

///|
pub fn aggregate_responses(
  survey : Survey,
  fingerprint : String,
  responses : Array[ProtectedResponse],
) -> SurveyReport raise KitError {
  let mechanisms = validate_survey(survey)
  if !hex_id(fingerprint, 64) ||
    responses.is_empty() ||
    responses.length() > 100000 {
    raise KitError(
      "provide a valid fingerprint and between 1 and 100000 response files",
    )
  }
  let seen : Map[String, Array[Int]] = Map([])
  let counts = mechanisms.map(fn(m) { Array::make(m.categories, 0) })
  let mut duplicates = 0
  for response in responses {
    if response.schema_version != 1 ||
      response.mechanism != "rr24-v1" ||
      response.survey_fingerprint != fingerprint ||
      !hex_id(response.response_id, 32) ||
      response.answers.length() != mechanisms.length() {
      raise KitError("response does not belong to this survey configuration")
    }
    for i = 0; i < mechanisms.length(); i = i + 1 {
      if response.answers[i] < 0 ||
        response.answers[i] >= mechanisms[i].categories {
        raise KitError("protected response contains an out of domain category")
      }
    }
    match seen.get(response.response_id) {
      Some(previous) => {
        if previous != response.answers {
          raise KitError("conflicting response files share an identifier")
        }
        duplicates = duplicates + 1
      }
      None => {
        seen[response.response_id] = response.answers
        for i = 0; i < mechanisms.length(); i = i + 1 {
          counts[i][response.answers[i]] = counts[i][response.answers[i]] + 1
        }
      }
    }
  }
  let results : Array[QuestionResult] = []
  for i = 0; i < mechanisms.length(); i = i + 1 {
    let question = survey.questions[i]
    results.push({
      id: question.id,
      title: question.title,
      options: question.options,
      statistics: estimate(
        mechanisms[i],
        counts[i],
        alpha=0.05 / mechanisms.length().to_double(),
      ),
    })
  }
  {
    survey_id: survey.id,
    accepted: seen.length(),
    duplicates,
    questionnaire_confidence: 0.95,
    questions: results,
  }
}

///|
pub extend Question with @json.FromJson::{from_json}

///|
pub extend Survey with @json.FromJson::{from_json}

///|
pub extend ProtectedResponse with @json.FromJson::{from_json}
