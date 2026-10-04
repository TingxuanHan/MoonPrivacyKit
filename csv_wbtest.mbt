///|
test "CSV preserves Unicode commas quotes embedded newlines and empty final cells" {
  let table = parse_csv(
    "\u{FEFF}name,note,extra\r\n小林,\"hello,\"\"world\"\"\nnext\",\r\n",
  )
  assert_eq(table.headers, ["name", "note", "extra"])
  assert_eq(table.rows, [["小林", "hello,\"world\"\nnext", ""]])
}

///|
test "CSV rejects malformed rows and ambiguous headers" {
  for
    input in [
      "", "a,a\n1,2", "a,\n1,2", "a,b\n1", "a\n\"unclosed", "a\n\"closed\"bad", "a\nun\"quoted",
    ] {
    let rejected = try {
      ignore(parse_csv(input))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
test "CSV redaction removes values and audit stores only counts" {
  let result = redact_csv(
    "name,email,group\nAlice,alice@example.test,A\nBob,bob@example.test,B",
    { remove: ["name"], mask: ["email"], },
  )
  let table = parse_csv(result.output)
  assert_eq(table.headers, ["email", "group"])
  assert_eq(table.rows, [["[REDACTED]", "A"], ["[REDACTED]", "B"]])
  assert_eq(result.audit.removed_values, 2)
  assert_eq(result.audit.masked_values, 2)
  assert_true(!result.audit.to_json().stringify().contains("Alice"))
}

///|
test "spreadsheet export escapes formula cells with a documented opt out" {
  let policy = { remove: ["private"], mask: [], }
  let safe = redact_csv("private,formula\nx,=1+2", policy)
  assert_eq(parse_csv(safe.output).rows[0][0], "'=1+2")
  assert_eq(safe.audit.spreadsheet_escapes, 1)
  let exact = redact_csv(
    "private,formula\nx,=1+2",
    policy,
    spreadsheet_safe=false,
  )
  assert_eq(parse_csv(exact.output).rows[0][0], "=1+2")
}

///|
test "CSV policies reject misspellings conflicting rules and empty output" {
  for
    policy in [
      { remove: ["missing"], mask: [], },
      { remove: ["name"], mask: ["name"], },
      { remove: [], mask: [], },
      { remove: ["name", "group"], mask: [], },
    ] {
    let rejected = try {
      ignore(redact_csv("name,group\nAlice,A", policy))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
