///|
test "JSON redaction handles mixed records and counts only existing fields" {
  let input = "[{\"name\":\"Alice\",\"contact\":{\"email\":\"secret@example.test\"},\"score\":4},{\"score\":3}]"
  let result = redact_json(input, { remove: ["name"], mask: ["contact"], })
  assert_eq(
    read_json(result.output),
    read_json("[{\"contact\":\"[REDACTED]\",\"score\":4},{\"score\":3}]"),
  )
  assert_eq(result.audit.records, 2)
  assert_eq(result.audit.removed_values, 1)
  assert_eq(result.audit.masked_values, 1)
  assert_true(!result.output.contains("secret@example.test"))
}

///|
test "JSON object shape and unselected nested values are preserved" {
  let input = "{\"private\":null,\"nested\":{\"keep\":[true,2,\"文字\"]}}"
  let result = redact_json(input, { remove: ["private"], mask: [], })
  assert_eq(
    read_json(result.output),
    read_json("{\"nested\":{\"keep\":[true,2,\"文字\"]}}"),
  )
  assert_eq(result.audit.removed_values, 1)
}

///|
test "JSON field inspection exposes names and rejects scalar records" {
  assert_eq(inspect_fields("json", "[{\"a\":1},{\"b\":2,\"a\":3}]"), ["a", "b"])
  for input in ["1", "null", "[1]", "[{\"a\":1},null]", "not-json"] {
    let rejected = try {
      ignore(inspect_fields("json", input))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
