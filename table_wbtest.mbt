///|
fn histogram_mapping() -> TableMapping {
  {
    query: "histogram",
    unit_field: "person_id",
    category_field: "choice",
    categories: ["满意", "一般", "不满意"],
  }
}

///|
fn count_mapping() -> TableMapping {
  {
    query: "count",
    unit_field: "person_id",
    category_field: "",
    categories: [],
  }
}

///|
test "table mapping preserves CSV quoting Unicode record order and string identifiers" {
  let csv = map_table(
    "csv",
    "\u{FEFF}note,choice,person_id\r\n\"comma, and\nline\",满意,001\r\nignored,不满意,001\r\nignored,一般,002\r\n",
    histogram_mapping(),
  )
  let json = map_table(
    "json",
    "[{\"person_id\":\"001\",\"choice\":\"满意\",\"note\":{\"nested\":true}},{\"person_id\":\"001\",\"choice\":\"不满意\"},{\"person_id\":\"002\",\"choice\":\"一般\"}]",
    histogram_mapping(),
  )
  assert_eq(csv.unit_ids, ["001", "001", "002"])
  assert_eq(csv.category_ids, [0, 2, 1])
  assert_eq(csv.to_json(), json.to_json())
}

///|
test "mapped tables retain person grouping for count and histogram contribution bounds" {
  let mapped = map_table(
    "csv",
    "person_id,choice\na,满意\na,不满意\nb,一般",
    histogram_mapping(),
  )
  assert_eq(
    central_histogram(
      mapped.unit_ids,
      mapped.category_ids,
      make_central_mechanism(3, 1.0, 1),
      _ => 0,
    ).counts,
    [1, 1, 0],
  )
  assert_eq(
    central_histogram(
      mapped.unit_ids,
      mapped.category_ids,
      make_central_mechanism(3, 1.0, 2),
      _ => 0,
    ).counts,
    [1, 1, 1],
  )
  let count = map_table(
    "json",
    "[{\"person_id\":\"a\"},{\"person_id\":\"a\"},{\"person_id\":\"b\"}]",
    count_mapping(),
  )
  assert_eq(
    central_count(count.unit_ids, make_central_mechanism(1, 1.0, 1), _ => 0).counts,
    [2],
  )
}

///|
test "table mapping rejects missing ambiguous and invalid mapped values without echoing input" {
  for
    (format, input) in [
      ("csv", "person_id,choice\n,满意"),
      ("csv", "person_id,choice\n secret-person,满意"),
      ("csv", "person_id,choice\nsecret-person ,满意"),
      ("csv", "person_id,choice\na,满意\na,secret-category"),
      ("csv", "person_id,person_id,choice\na,b,满意"),
      ("csv", "other,choice\na,满意"),
      ("csv", "person_id,other\na,满意"),
      ("csv", "person_id,choice\na"),
      (
        "json", "[{\"person_id\":\"a\",\"choice\":\"满意\"},{\"choice\":\"一般\"}]",
      ),
      ("json", "{\"person_id\":1,\"choice\":\"满意\"}"),
      ("json", "{\"person_id\":null,\"choice\":\"满意\"}"),
      ("json", "{\"person_id\":true,\"choice\":\"满意\"}"),
      ("json", "{\"person_id\":\"a\",\"choice\":{\"secret-value\":1}}"),
      ("json", "{\"person_id\":\"a\",\"choice\":null}"),
      ("json", "{\"person_id\":\"a\",\"choice\":2}"),
      ("json", "{\"person_id\":\"a\"}"),
      ("json", "[1]"),
      ("json", "secret-invalid-json"),
      ("xlsx", "secret-file"),
    ] {
    let rejected = try {
      ignore(map_table(format, input, histogram_mapping()))
      false
    } catch {
      KitError(message) => {
        assert_true(!message.contains("secret"))
        true
      }
    }
    assert_true(rejected)
  }
}

///|
test "JSON table keys reject duplicates including escaped and nested spellings" {
  for
    input in [
      "{\"person_id\":\"a\",\"person_id\":\"b\"}", "{\"person_id\":\"a\",\"person_\\u0069d\":\"b\"}",
      "{\"person_id\":\"a\",\"note\":{\"x\":1,\"x\":2}}",
    ] {
    let rejected = try {
      ignore(map_table("json", input, count_mapping()))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
  let valid = map_table(
    "json",
    "[{\"person_id\":\"a\",\"note\":\"{\\\"key\\\":}\\\\\"},{\"person_id\":\"b\",\"note\":{\"person_id\":\"c\"}}]",
    count_mapping(),
  )
  assert_eq(valid.unit_ids, ["a", "b"])
}

///|
test "table mappings require explicit valid fields queries and public categories" {
  let long = Array::make(129, "x").join("")
  for
    mapping in [
      {
        query: "mean",
        unit_field: "person_id",
        category_field: "",
        categories: [],
      },
      { query: "count", unit_field: " ", category_field: "", categories: [], },
      {
        query: "count",
        unit_field: "person_id",
        category_field: "choice",
        categories: [],
      },
      {
        query: "count",
        unit_field: "person_id",
        category_field: "",
        categories: ["x"],
      },
      {
        query: "histogram",
        unit_field: "person_id",
        category_field: "",
        categories: ["x"],
      },
      {
        query: "histogram",
        unit_field: "person_id",
        category_field: "choice",
        categories: [],
      },
      {
        query: "histogram",
        unit_field: "person_id",
        category_field: "choice",
        categories: ["x", "x"],
      },
      {
        query: "histogram",
        unit_field: "person_id",
        category_field: "choice",
        categories: [" "],
      },
      {
        query: "histogram",
        unit_field: "person_id",
        category_field: "choice",
        categories: [long],
      },
    ] {
    let rejected = try {
      ignore(map_table("json", "[]", mapping))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
test "empty tables keep the declared domain and do not fabricate individuals" {
  for (format, input) in [("csv", "person_id,choice\n"), ("json", "[]")] {
    let mapped = map_table(format, input, histogram_mapping())
    assert_eq(mapped.unit_ids, [])
    assert_eq(mapped.category_ids, [])
    assert_eq(
      central_histogram(
        mapped.unit_ids,
        mapped.category_ids,
        make_central_mechanism(3, 1.0, 1),
        _ => 0,
      ).counts,
      [0, 0, 0],
    )
  }
}

///|
test "table mapping enforces identifier field and heterogeneous schema limits" {
  let long = Array::make(129, "x").join("")
  let fields : Map[String, Json] = Map([])
  fields["person_id"] = "a"
  for i = 0; i < 512; i = i + 1 {
    fields["extra\{i}"] = null
  }
  for
    (format, input, mapping) in [
      ("csv", "person_id\n" + long, count_mapping()),
      ("json", Json::object(fields).stringify(), count_mapping()),
      (
        "json",
        "[]",
        {
          query: "count",
          unit_field: long + long,
          category_field: "",
          categories: [],
        },
      ),
    ] {
    let rejected = try {
      ignore(map_table(format, input, mapping))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
