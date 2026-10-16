///|
fn workflow_test_plan(early_drop : Bool) -> Json {
  let keep : Json = {
    "id": "keep",
    "op": "select_fields",
    "input": "source",
    "settings": { "keep": ["value"] },
  }
  let bound : Json = {
    "id": "bound",
    "op": "bound_person",
    "input": if early_drop {
      "keep"
    } else {
      "source"
    },
    "settings": { "max_rows": 3, "origin": "public" },
  }
  let steps : Array[Json] = if early_drop { [keep, bound] } else { [bound] }
  steps.push({
    "id": "sum",
    "op": "aggregate",
    "input": "bound",
    "settings": {
      "query": "bounded_sum",
      "value_field": "value",
      "upper": 7,
      "origin": "public",
    },
  })
  steps.push({
    "id": "release",
    "op": "dp_release",
    "input": "sum",
    "settings": { "epsilon_units": 500000, "trust": "trusted_holder" },
  })
  steps.push({
    "id": "chart",
    "op": "postprocess",
    "input": "release",
    "settings": { "format": "chart" },
  })
  {
    "schema_version": 1,
    "kind": "moonprivacykit/privacy-workflow",
    "scope": "cohort",
    "budget": { "total_epsilon_units": 1000000, "spent_epsilon_units": 500000 },
    "sources": [
      {
        "id": "source",
        "kind": "private_table",
        "fields": ["id", "value"],
        "person_field": "id",
        "selection_origin": "public",
      },
    ],
    "steps": Json(steps),
    "outputs": [
      { "node": "release", "audience": "public" },
      { "node": "chart", "audience": "public" },
    ],
  }
}

///|
test "workflow sensitivity is person contribution times public value bound" {
  let report = check_privacy_workflow(workflow_test_plan(false).stringify())
  assert_eq(field(report, "status"), Json("compatible"))
  let checks : Array[Json] = decode(field(report, "checks"))
  assert_eq(field(checks[2], "l1_sensitivity"), Json(21))
  let budget = field(report, "budget")
  assert_eq(field(budget, "planned_epsilon_units"), Json(500000))
  assert_eq(field(budget, "remaining_after_plan_units"), Json(0))
  assert_eq(field(checks[4], "release_node"), Json("release"))
}

///|
test "workflow reports the first broken ownership dependency" {
  let report = check_privacy_workflow(workflow_test_plan(true).stringify())
  assert_eq(field(report, "status"), Json("blocked"))
  let issues : Array[Json] = decode(field(report, "issues"))
  assert_eq(field(issues[0], "code"), Json("PERSON_FIELD_MISSING"))
  assert_eq(field(issues[0], "path"), Json(["source", "keep", "bound"]))
  assert_eq(field(field(report, "budget"), "estimate_complete"), Json(false))
}

///|
test "unknown operation remains inconclusive after downstream presentation" {
  let document = workflow_test_plan(false)
    .stringify()
    .replace(old="dp_release", new="unverified_dp")
  let report = check_privacy_workflow(document)
  assert_eq(field(report, "status"), Json("inconclusive"))
  let outputs : Array[Json] = decode(field(report, "outputs"))
  assert_eq(field(outputs[1], "status"), Json("unverified"))
}
