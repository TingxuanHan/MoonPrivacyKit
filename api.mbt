///|
fn field(value : Json, key : String) -> Json raise KitError {
  match value {
    Object(fields) =>
      match fields.get(key) {
        Some(v) => v
        None => raise KitError("required request field is missing")
      }
    _ => raise KitError("request must be an object")
  }
}

///|
fn[T : @json.FromJson] decode(value : Json) -> T raise KitError {
  @json.from_json(value) catch {
    _ => raise KitError("invalid request field type")
  }
}

///|
fn decode_int(value : Json) -> Int32 raise KitError {
  match value {
    Number(n, ..) if finite(n) &&
      n >= -2147483648.0 &&
      n <= 2147483647.0 &&
      @math.floor(n) == n => n.to_int()
    _ => raise KitError("expected an integer in the supported range")
  }
}

///|
fn decode_ints(value : Json) -> Array[Int32] raise KitError {
  match value {
    Array(values) => values.map(v => decode_int(v))
    _ => raise KitError("expected an array of integers")
  }
}

///|
fn[T : ToJson] nullable_json(value : T?) -> Json {
  match value {
    Some(value) => Json(value)
    None => Json::null()
  }
}

///|
fn execute_request(request : Json) -> Json raise KitError {
  let op : String = decode(field(request, "op"))
  match op {
    "parseSyntheticPlan" => {
      let input : String = decode(field(request, "input"))
      if input.length() > 100000 {
        raise KitError("synthetic plan exceeds input limit")
      }
      let value = read_json(input)
      reject_duplicate_table_keys(input)
      ignore(plan_synthetic(value))
      value
    }
    "planSynthetic" => plan_synthetic(field(request, "plan"))
    "mapSynthetic" =>
      map_synthetic(
        field(request, "plan"),
        decode(field(request, "format")),
        decode(field(request, "input")),
      )
    "checkPrivacyWorkflow" =>
      check_privacy_workflow(decode(field(request, "input")))
    "inspectDisclosure" => inspect_disclosure(field(request, "model"))
    "validateAggregateConfig" =>
      validate_aggregate_config(field(request, "config"))
    "splitAggregate" =>
      split_aggregate(
        decode_ints(field(request, "values")),
        decode_ints(field(request, "masks")),
        decode_int(field(request, "upper")),
      )
    "sumAggregateShares" => {
      let vectors : Array[Json] = decode(field(request, "vectors"))
      Json(
        sum_aggregate_shares(
          vectors.map(v => decode_ints(v)),
          decode_int(field(request, "dimensions")),
        ),
      )
    }
    "combineAggregateShares" =>
      Json(
        combine_aggregate_shares(
          decode_ints(field(request, "left")),
          decode_ints(field(request, "right")),
          decode_int(field(request, "participants")),
          decode_int(field(request, "upper")),
        ),
      )
    "validateCredentialContext" =>
      validate_credential_context(field(request, "context"))
    "validateCredentialResponse" =>
      validate_credential_response(
        parse_survey(field(request, "survey").stringify()),
        decode(field(request, "fingerprint")),
        field(request, "response"),
      )
    "planPersonQuery" => plan_person_query(field(request, "plan"))
    "scanSensitiveFields" =>
      scan_sensitive_fields(
        decode(field(request, "format")),
        decode(field(request, "input")),
      )
    "scrubText" => scrub_text(decode(field(request, "input")))
    "comparePrivacyPlans" =>
      compare_privacy_plans(
        decode(field(request, "format")),
        decode(field(request, "input")),
        field(request, "config"),
      )
    "comparePrivateVersions" =>
      compare_private_versions(
        decode(field(request, "left_format")),
        decode(field(request, "left")),
        decode(field(request, "right_format")),
        decode(field(request, "right")),
        field(request, "config"),
      )
    "mapPersonQuery" =>
      map_person_query(
        field(request, "plan"),
        decode(field(request, "left_format")),
        decode(field(request, "left")),
        decode(field(request, "right_format")),
        decode(field(request, "right")),
      )
    "assessSurvey" =>
      assess_survey(
        parse_survey(field(request, "survey").stringify()),
        decode_int(field(request, "samples")),
        decode(field(request, "target_radius")),
        collections=decode_int(field(request, "collections")),
      ).to_json()
    "parseSurveyTemplate" =>
      parse_survey_template(decode(field(request, "input"))).to_json()
    "surveyFromTemplate" =>
      survey_from_template(
        parse_survey_template(decode(field(request, "template"))),
        decode(field(request, "survey_id")),
      ).to_json()
    "surveyBudget" =>
      survey_budget(
        parse_survey(field(request, "survey").stringify()),
        decode_int(field(request, "collections")),
      ).to_json()
    "parseSurvey" => parse_survey(decode(field(request, "input"))).to_json()
    "parseStatisticsTemplate" =>
      parse_statistics_template(decode(field(request, "input"))).to_json()
    "checkStatisticsTemplate" =>
      check_statistics_template(
        parse_statistics_template(decode(field(request, "template"))),
        decode(field(request, "format")),
        decode(field(request, "input")),
      ).to_json()
    "mapTable" =>
      map_table(
        decode(field(request, "format")),
        decode(field(request, "input")),
        decode(field(request, "mapping")),
      ).to_json()
    "budgetState" =>
      make_budget_state(
        decode_int(field(request, "total_units")),
        decode_int(field(request, "spent_units")),
      ).to_json()
    "chargeBudget" =>
      charge_budget(
        make_budget_state(
          decode_int(field(request, "total_units")),
          decode_int(field(request, "spent_units")),
        ),
        decode_int(field(request, "charge_units")),
      ).to_json()
    "validateCentral" => {
      let (_, mechanism, _) = prepare_central_request(field(request, "request"))
      mechanism.to_json()
    }
    "centralMechanism" =>
      make_central_mechanism(
        decode_int(field(request, "category_count")),
        decode(field(request, "epsilon")),
        decode_int(field(request, "max_contributions")),
      ).to_json()
    "mechanism" =>
      make_mechanism(
        decode_int(field(request, "categories")),
        decode(field(request, "epsilon")),
      ).to_json()
    "estimate" => {
      let m = make_mechanism(
        decode_int(field(request, "categories")),
        decode(field(request, "epsilon")),
      )
      estimate(m, decode_ints(field(request, "counts"))).to_json()
    }
    "randomizeBatch" => {
      let m = make_mechanism(
        decode_int(field(request, "categories")),
        decode(field(request, "epsilon")),
      )
      let answers = decode_ints(field(request, "answers"))
      let gates = decode_ints(field(request, "gates"))
      let fallbacks = decode_ints(field(request, "fallbacks"))
      if answers.length() > 100000 ||
        answers.length() != gates.length() ||
        answers.length() != fallbacks.length() {
        raise KitError(
          "batch dimensions must match and contain at most 100000 items",
        )
      }
      let result : Array[Int32] = []
      for i = 0; i < answers.length(); i = i + 1 {
        result.push(randomize(m, answers[i], gates[i], fallbacks[i]))
      }
      Json(result)
    }
    "plan" => {
      let m = make_mechanism(
        decode_int(field(request, "categories")),
        decode(field(request, "epsilon")),
      )
      let questions : Int32 = decode_int(field(request, "questions"))
      if questions < 1 || questions > 100 {
        raise KitError("question count must be between 1 and 100")
      }
      let plan = plan_survey(
        Array::make(questions, m),
        decode_int(field(request, "samples")),
        collections=decode_int(field(request, "collections")),
      )
      let needed = required_samples(
        m,
        decode(field(request, "radius")),
        alpha=0.05 / questions.to_double(),
      )
      {
        "plan": plan.to_json(),
        "required_samples": nullable_json(needed),
        "mechanism": m.to_json(),
      }
    }
    "validateSurvey" =>
      parse_survey(field(request, "survey").stringify()).to_json()
    "protect" => {
      let survey = parse_survey(field(request, "survey").stringify())
      protect_response(
        survey,
        decode(field(request, "fingerprint")),
        decode(field(request, "response_id")),
        decode_ints(field(request, "answers")),
        decode_ints(field(request, "gates")),
        decode_ints(field(request, "fallbacks")),
      ).to_json()
    }
    "aggregate" => {
      let survey = parse_survey(field(request, "survey").stringify())
      let values : Array[Json] = decode(field(request, "responses"))
      let responses = values.map(v => parse_response(v.stringify()))
      aggregate_responses(
        survey,
        decode(field(request, "fingerprint")),
        responses,
      ).to_json()
    }
    "parseRedactionTemplate" =>
      parse_redaction_template(decode(field(request, "input"))).to_json()
    "checkRedactionTemplate" =>
      check_redaction_template(
        parse_redaction_template(decode(field(request, "template"))),
        decode(field(request, "format")),
        decode(field(request, "input")),
      ).to_json()
    "applyRedactionTemplate" =>
      apply_redaction_template(
        parse_redaction_template(decode(field(request, "template"))),
        decode(field(request, "format")),
        decode(field(request, "input")),
      ).to_json()
    "prepareRedactionHandoff" =>
      prepare_redaction_handoff(
        parse_redaction_template(decode(field(request, "template"))),
        decode(field(request, "format")),
        decode(field(request, "input")),
      ).to_json()
    "inspect" =>
      Json(
        inspect_fields(
          decode(field(request, "format")),
          decode(field(request, "input")),
        ),
      )
    "redact" => {
      let format : String = decode(field(request, "format"))
      let input : String = decode(field(request, "input"))
      let policy : FieldPolicy = decode(field(request, "policy"))
      match format {
        "csv" =>
          redact_csv(
            input,
            policy,
            spreadsheet_safe=decode(field(request, "spreadsheet_safe")),
          ).to_json()
        "json" => redact_json(input, policy).to_json()
        _ => raise KitError("supported file formats are csv and json")
      }
    }
    _ => raise KitError("unknown operation")
  }
}

///|
/// JSON boundary for host applications. Error messages never echo input values.
pub fn dispatch(input : String) -> String {
  let result : Json = try {
    if input.length() > 10_000_000 {
      raise KitError("request exceeds the 10 MB text limit")
    }
    { "ok": true, "data": execute_request(read_json(input)) }
  } catch {
    KitError(message) => { "ok": false, "error": message }
  }
  result.stringify()
}

///|
fn prepare_central_request(
  request : Json,
) -> (Array[Int32], CentralMechanism, String) raise KitError {
  let op : String = decode(field(request, "op"))
  if op == "centralSum" {
    return prepare_sum_request(request)
  }
  let categories = match op {
    "centralCount" => 1
    "centralHistogram" => decode_int(field(request, "category_count"))
    _ => raise KitError("unknown central operation")
  }
  let mechanism = make_central_mechanism(
    categories,
    decode(field(request, "epsilon")),
    decode_int(field(request, "max_contributions")),
  )
  let units : Array[String] = decode(field(request, "unit_ids"))
  if units.length() > CENTRAL_RECORD_LIMIT {
    raise KitError(
      "central input arrays must match and contain at most 100000 records",
    )
  }
  let bins = if op == "centralCount" {
    Array::make(units.length(), 0)
  } else {
    decode_ints(field(request, "category_ids"))
  }
  (
    central_bounded_counts(units, bins, mechanism),
    mechanism,
    if op == "centralCount" {
      "count"
    } else {
      "histogram"
    },
  )
}

///|
/// Low-level host boundary: random_below must supply fresh secure uniform draws.
/// Validation failures are for the trusted holder, not a public query endpoint.
pub fn dispatch_central(
  input : String,
  random_below : (Int32) -> Int32,
) -> String {
  let result : Json = try {
    if input.length() > 10_000_000 {
      raise KitError("request exceeds the 10 MB text limit")
    }
    let (counts, mechanism, query) = prepare_central_request(read_json(input))
    let release = central_release(counts, mechanism, query, random_below)
    { "ok": true, "data": release.to_json() }
  } catch {
    KitError(message) => { "ok": false, "error": message }
  }
  result.stringify()
}
