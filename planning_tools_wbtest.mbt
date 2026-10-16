///|
test "linked versions expose a four-person intersection without emitting identities" {
  let left = "[{\"id\":\"private-a\",\"x\":0},{\"id\":\"private-b\",\"x\":0},{\"id\":\"private-c\",\"x\":1},{\"id\":\"private-d\",\"x\":1}]"
  let right = "[{\"id\":\"private-a\",\"y\":0},{\"id\":\"private-b\",\"y\":1},{\"id\":\"private-c\",\"y\":0},{\"id\":\"private-d\",\"y\":1}]"
  let report = compare_private_versions("json", left, "json", right, {
    "schema_version": 1,
    "unit_field": "id",
    "left_fields": ["x"],
    "right_fields": ["y"],
    "k": 2,
    "assume_linkable": true,
  })
  assert_eq(decode_int(field(report, "newly_below_k_rows")), 4)
  assert_true(!report.stringify().contains("private-a"))
}

///|
test "upstream content scanning excludes original sensitive values" {
  let report = scan_sensitive_fields(
    "json", "[{\"contact\":\"person@private-company.org\"}]",
  )
  let findings : Array[Json] = decode(field(report, "findings"))
  assert_eq(findings.length(), 1)
  assert_true(!report.stringify().contains("person@private-company.org"))
  let scrubbed = scrub_text("person@private-company.org")
  assert_true(!scrubbed.stringify().contains("person@private-company.org"))
}
