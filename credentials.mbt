///|
/// Public protocol context shared by every participant in the survey. Individual
/// identifiers and per-person keys must not enter this context.
pub fn validate_credential_context(value : Json) -> Json raise KitError {
  require_keys(value, [
    "schema_version", "kind", "survey_fingerprint", "expires_at", "suite",
  ])
  let version = decode_int(field(value, "schema_version"))
  let kind : String = decode(field(value, "kind"))
  let fingerprint : String = decode(field(value, "survey_fingerprint"))
  let expires : Double = decode(field(value, "expires_at"))
  let suite : String = decode(field(value, "suite"))
  if version != 1 ||
    kind != "moonprivacykit/anonymous-survey" ||
    !hex_id(fingerprint, 64) ||
    !finite(expires) ||
    @math.floor(expires) != expires ||
    expires < 1.0 ||
    expires > 4102444800.0 ||
    suite != "RSABSSA-SHA384-PSS-Randomized" {
    raise KitError("invalid anonymous survey context")
  }
  value
}

///|
pub fn validate_credential_response(
  survey : Survey,
  fingerprint : String,
  value : Json,
) -> Json raise KitError {
  let mechanisms = validate_survey(survey)
  let response = parse_response(value.stringify())
  if !hex_id(fingerprint, 64) ||
    response.schema_version != 1 ||
    response.mechanism != "rr24-v1" ||
    response.survey_fingerprint != fingerprint ||
    !hex_id(response.response_id, 32) ||
    response.answers.length() != mechanisms.length() {
    raise KitError("credential response does not belong to this survey")
  }
  for i in 0..<mechanisms.length() {
    if response.answers[i] < 0 ||
      response.answers[i] >= mechanisms[i].categories {
      raise KitError(
        "credential response option is outside the declared domain",
      )
    }
  }
  response.to_json()
}
