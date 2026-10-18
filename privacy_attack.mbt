///|
priv struct AttackPlan {
  unit : String
  known : Array[String]
  sensitive : String
  values : Array[String]
  seed : Int32
}

///|
priv struct AttackRow {
  features : Array[String]
  label : Int32
}

///|
fn attack_plan(value : Json) -> AttackPlan raise KitError {
  require_keys(value, [
    "schema_version", "unit_field", "known_fields", "sensitive_field", "sensitive_values",
    "split_seed",
  ])
  let unit : String = decode(field(value, "unit_field"))
  let known : Array[String] = decode(field(value, "known_fields"))
  let sensitive : String = decode(field(value, "sensitive_field"))
  let values : Array[String] = decode(field(value, "sensitive_values"))
  let seed = decode_int(field(value, "split_seed"))
  if decode_int(field(value, "schema_version")) != 1 ||
    known.length() < 1 ||
    known.length() > 5 ||
    values.length() < 2 ||
    values.length() > 8 ||
    seed < 1 ||
    seed > 2147483646 {
    raise KitError(
      "audit plan requires version 1, 1 to 5 known fields, 2 to 8 sensitive categories and seed 1 to 2147483646",
    )
  }
  let seen : Map[String, Bool] = Map([])
  for name in [unit, sensitive] + known {
    table_field_name(name)
    if seen.contains(name) || name.contains("\n") || name.contains("\r") {
      raise KitError(
        "audit fields must be distinct single-line names; identifiers cannot be attack features",
      )
    }
    seen[name] = true
  }
  let labels : Map[String, Bool] = Map([])
  for label in values {
    if label.trim().is_empty() ||
      label.length() > 128 ||
      labels.contains(label) ||
      label.contains("\n") ||
      label.contains("\r") {
      raise KitError(
        "audit categories must be distinct nonempty single-line strings of at most 128 characters",
      )
    }
    labels[label] = true
  }
  { unit, known, sensitive, values, seed, }
}

///|
pub fn parse_privacy_attack_plan(input : String) -> Json raise KitError {
  if input.length() > 100000 {
    raise KitError("audit plan exceeds input limit")
  }
  let value = read_json(input)
  reject_duplicate_table_keys(input)
  ignore(attack_plan(value))
  value
}

///|
fn attack_features(
  row : Map[String, Json],
  plan : AttackPlan,
) -> (Array[String], Int32) raise KitError {
  let features = plan.known.map(name => table_string(row, name))
  for value in features {
    if value.trim().is_empty() || value.length() > 128 {
      raise KitError(
        "audit feature values must be nonempty strings of at most 128 characters",
      )
    }
  }
  let sensitive = table_string(row, plan.sensitive)
  let label = match plan.values.search(sensitive) {
    Some(index) => index
    None =>
      raise KitError("audit sensitive value is outside the declared categories")
  }
  (features, label)
}

///|
fn attack_private_rows(
  source : Json,
  plan : AttackPlan,
  seen : Map[String, Bool],
) -> Array[AttackRow] raise KitError {
  require_keys(source, ["format", "input"])
  let rows = person_rows(
    decode(field(source, "format")),
    decode(field(source, "input")),
  )
  if rows.length() < 20 || rows.length() > 2000 {
    raise KitError(
      "audit member and nonmember tables each require 20 to 2000 people",
    )
  }
  let by_id : Map[String, AttackRow] = Map([])
  let ids : Array[String] = []
  for row in rows {
    let id = person_id(row, plan.unit)
    if seen.contains(id) {
      raise KitError(
        "audit identifiers must be unique and disjoint across member and nonmember tables",
      )
    }
    seen[id] = true
    let (features, label) = attack_features(row, plan)
    ids.push(id)
    by_id[id] = { features, label, }
  }
  ids.sort_by((left, right) => left.lexical_compare(right))
  ids.map(id => by_id[id])
}

///|
fn attack_release_rows(
  source : Json,
  plan : AttackPlan,
) -> Array[AttackRow] raise KitError {
  require_keys(source, ["format", "input"])
  let format : String = decode(field(source, "format"))
  let input : String = decode(field(source, "input"))
  if input.length() > 2000000 {
    raise KitError("audit release exceeds input limit")
  }
  let rows = if format == "artifact" {
    let value = read_json(input)
    reject_duplicate_table_keys(input)
    let table = field(value, "synthetic")
    let kind : String = decode(field(table, "kind"))
    if kind != "moonprivacykit/synthetic-table" ||
      decode_int(field(table, "schema_version")) != 1 {
      raise KitError("audit requires a version 1 synthetic table artifact")
    }
    let columns : Array[String] = decode(field(table, "columns"))
    let records : Array[Array[String]] = decode(field(table, "rows"))
    if columns.length() != plan.known.length() + 1 || records.length() > 5000 {
      raise KitError(
        "audit release columns or size do not match the declared scope",
      )
    }
    let unique : Map[String, Bool] = Map([])
    for name in columns {
      if unique.contains(name) {
        raise KitError("audit release columns must be distinct")
      }
      unique[name] = true
    }
    records.map(record => {
      if record.length() != columns.length() {
        raise KitError("audit release row width does not match columns")
      }
      let row : Map[String, Json] = Map([])
      for i in 0..<columns.length() {
        row[columns[i]] = Json(record[i])
      }
      row
    })
  } else {
    person_rows(format, input)
  }
  if rows.is_empty() || rows.length() > 5000 {
    raise KitError("audit release requires 1 to 5000 rows")
  }
  rows.map(row => {
    // Refuse to silently omit a released identifier or other unexamined column.
    if row.length() != plan.known.length() + 1 || row.contains(plan.unit) {
      raise KitError(
        "audit release must contain exactly the known and sensitive fields, without identifiers or extra columns",
      )
    }
    let (features, label) = attack_features(row, plan)
    { features, label, }
  })
}

///|
/// Park-Miller with Schrage arithmetic and rejection sampling, used ONLY for
/// a reproducible evaluation split. Never used by a privacy mechanism.
fn attack_shuffle(rows : Array[AttackRow], initial : Int32) -> Unit {
  let mut state = initial
  for i = rows.length() - 1; i > 0; i = i - 1 {
    let bound = i + 1
    let limit = 2147483646 / bound * bound
    let mut draw = limit
    while draw >= limit {
      state = 48271 * (state % 44488) - 3399 * (state / 44488)
      if state <= 0 {
        state = state + 2147483647
      }
      draw = state - 1
    }
    let j = draw % bound
    let previous = rows[i]
    rows[i] = rows[j]
    rows[j] = previous
  }
}

///|
fn attack_distance(left : AttackRow, right : AttackRow) -> Int32 {
  let mut distance = 0
  for i in 0..<left.features.length() {
    if left.features[i] != right.features[i] {
      distance = distance + 1
    }
  }
  distance
}

///|
fn attack_score(row : AttackRow, released : Array[AttackRow]) -> Int32 {
  let mut best = row.features.length() + 2
  for other in released {
    let distance = attack_distance(row, other) +
      (if row.label == other.label { 0 } else { 1 })
    if distance < best {
      best = distance
    }
  }
  best
}

///|
fn attack_majority(counts : Array[Int32]) -> Int32 {
  let mut best = 0
  for i in 1..<counts.length() {
    // Ties always use the earlier declared category, never a target's label.
    if counts[i] > counts[best] {
      best = i
    }
  }
  best
}

///|
fn attack_predict(
  row : AttackRow,
  released : Array[AttackRow],
  categories : Int32,
) -> Int32 {
  let counts = Array::make(categories, 0)
  let mut nearest = row.features.length() + 1
  for other in released {
    let distance = attack_distance(row, other)
    if distance < nearest {
      nearest = distance
      for i in 0..<counts.length() {
        counts[i] = 0
      }
    }
    if distance == nearest {
      counts[other.label] = counts[other.label] + 1
    }
  }
  attack_majority(counts)
}

///|
fn attack_interval(hits : Int32, n : Int32, z : Double) -> (Double, Double) {
  let count = n.to_double()
  let p = hits.to_double() / count
  let z2 = z * z
  let denominator = 1.0 + z2 / count
  let center = (p + z2 / (2.0 * count)) / denominator
  let radius = z *
    Double::sqrt(p * (1.0 - p) / count + z2 / (4.0 * count * count)) /
    denominator
  (clamp_proportion(center - radius), clamp_proportion(center + radius))
}

///|
fn attack_rate(hits : Int32, n : Int32) -> Json {
  let (lower, upper) = attack_interval(hits, n, 1.959963984540054)
  {
    "successes": Json(hits),
    "trials": Json(n),
    "rate": Json(hits.to_double() / n.to_double()),
    "lower95": Json(lower),
    "upper95": Json(upper),
  }
}

///|
fn attack_difference(a : Int32, n : Int32, b : Int32, m : Int32) -> Json {
  // Bonferroni construction from two 97.5% Wilson intervals. Approximate,
  // marginal intervals; not simultaneous across attacks, seeds or releases.
  let (al, au) = attack_interval(a, n, 2.241402727604947)
  let (bl, bu) = attack_interval(b, m, 2.241402727604947)
  {
    "estimate": Json(
      a.to_double() / n.to_double() - b.to_double() / m.to_double(),
    ),
    "lower95": Json(al - bu),
    "upper95": Json(au - bl),
  }
}

///|
fn attack_attribute(
  rows : Array[AttackRow],
  start : Int32,
  released : Array[AttackRow],
  categories : Int32,
  baseline : Int32,
) -> Json {
  let mut hits = 0
  let mut baseline_hits = 0
  let mut wins = 0
  let mut losses = 0
  for i in start..<rows.length() {
    let correct = attack_predict(rows[i], released, categories) == rows[i].label
    let base_correct = baseline == rows[i].label
    if correct {
      hits = hits + 1
    }
    if base_correct {
      baseline_hits = baseline_hits + 1
    }
    if correct && !base_correct {
      wins = wins + 1
    }
    if base_correct && !correct {
      losses = losses + 1
    }
  }
  let n = rows.length() - start
  {
    "accuracy": attack_rate(hits, n),
    "baseline_accuracy": attack_rate(baseline_hits, n),
    "gain": attack_difference(hits, n, baseline_hits, n),
    "wins_over_baseline": Json(wins),
    "losses_to_baseline": Json(losses),
  }
}

///|
/// Internal empirical assessment of ONE fixed categorical release. The caller
/// supplies ground truth; we cannot establish membership or population sampling.
/// This never samples synthetic data, publishes a result, or charges a ledger.
pub fn evaluate_privacy_attack(request : Json) -> Json raise KitError {
  let plan = attack_plan(field(request, "config"))
  let seen : Map[String, Bool] = Map([])
  let members = attack_private_rows(field(request, "members"), plan, seen)
  let controls = attack_private_rows(field(request, "nonmembers"), plan, seen)
  let released = attack_release_rows(field(request, "released"), plan)
  let dimensions = plan.known.length() + 1
  // All terms are bounded before multiplication, so this fits Int32.
  if (members.length() + controls.length()) *
    released.length() *
    (2 * dimensions) >
    20000000 {
    raise KitError(
      "audit exceeds the 20000000 comparison work limit; reduce input rows or fields",
    )
  }
  attack_shuffle(members, plan.seed)
  attack_shuffle(
    controls,
    if plan.seed == 2147483646 {
      1
    } else {
      plan.seed + 1
    },
  )
  let m_cal = members.length() / 2
  let c_cal = controls.length() / 2
  let m_test = members.length() - m_cal
  let c_test = controls.length() - c_cal
  let m_scores = members.map(row => attack_score(row, released))
  let c_scores = controls.map(row => attack_score(row, released))
  let mut threshold = -1
  let mut objective = 0
  for candidate in 0..<=dimensions {
    let mut positive = 0
    let mut false_positive = 0
    for i in 0..<m_cal {
      if m_scores[i] <= candidate {
        positive = positive + 1
      }
    }
    for i in 0..<c_cal {
      if c_scores[i] <= candidate {
        false_positive = false_positive + 1
      }
    }
    let score = positive * c_cal - false_positive * m_cal
    if score > objective {
      objective = score
      threshold = candidate
    }
  }
  let mut tp = 0
  let mut fp = 0
  for i in m_cal..<members.length() {
    if m_scores[i] <= threshold {
      tp = tp + 1
    }
  }
  for i in c_cal..<controls.length() {
    if c_scores[i] <= threshold {
      fp = fp + 1
    }
  }
  let prior = Array::make(plan.values.length(), 0)
  for i in 0..<c_cal {
    prior[controls[i].label] = prior[controls[i].label] + 1
  }
  let baseline = attack_majority(prior)
  {
    "schema_version": 1,
    "kind": "moonprivacykit/privacy-attack-report",
    "audience": "internal",
    "method": "categorical-hamming-holdout-v1",
    "known_fields": Json(plan.known),
    "sensitive_field": Json(plan.sensitive),
    "sensitive_category_count": Json(plan.values.length()),
    "release_rows": Json(released.length()),
    "split": {
      "seed": Json(plan.seed),
      "calibration_members": Json(m_cal),
      "calibration_nonmembers": Json(c_cal),
      "test_members": Json(m_test),
      "test_nonmembers": Json(c_test),
    },
    "membership": {
      "threshold_mismatches": Json(threshold),
      "true_positives": Json(tp),
      "false_negatives": Json(m_test - tp),
      "false_positives": Json(fp),
      "true_negatives": Json(c_test - fp),
      "true_positive_rate": attack_rate(tp, m_test),
      "false_positive_rate": attack_rate(fp, c_test),
      "balanced_accuracy": Json(
        (
          tp.to_double() / m_test.to_double() +
          1.0 -
          fp.to_double() / c_test.to_double()
        ) /
        2.0,
      ),
      "advantage": attack_difference(tp, m_test, fp, c_test),
    },
    "attribute": {
      "members": attack_attribute(
        members,
        m_cal,
        released,
        plan.values.length(),
        baseline,
      ),
      "nonmembers": attack_attribute(
        controls,
        c_cal,
        released,
        plan.values.length(),
        baseline,
      ),
    },
    "limitations": [
      "Internal private assessment; not a DP release, anonymity certificate or estimate of epsilon.",
      "Membership truth, common population and one-person correspondence are supplied by the user, not verified here.",
      "Membership attacker knows all selected fields; attribute attacker knows only the declared known fields.",
      "Intervals are approximate and marginal, conditional on one release and a fixed evaluation design; correlated people or selection bias invalidate population interpretation.",
      "Do not tune fields, seed or release using test scores and then treat those scores as independent confirmation.",
      "A weak or unsuccessful attack is inconclusive; private assessment results and data-dependent choices must not be published as DP output.",
    ],
  }
}
