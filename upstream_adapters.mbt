///|
/// Stateless admission against the exact remaining budget from the durable host.
/// The upstream in-memory reservation never becomes a second budget authority.
fn upstream_budget_admission(
  remaining_units : Int32,
  charge_units : Int32,
) -> Unit raise KitError {
  let available = match
    @upstream_core.PrivacyBudget::make(
      remaining_units.to_double() / 1000000.0,
      0.0,
    ) {
    Ok(v) => v
    Err(_) => raise KitError("upstream budget configuration rejected")
  }
  let cost = match
    @upstream_core.PrivacyBudget::make(
      charge_units.to_double() / 1000000.0,
      0.0,
    ) {
    Ok(v) => v
    Err(_) => raise KitError("upstream budget cost rejected")
  }
  let ledger = @upstream_ledger.PrivacyLedger::new()
  let account = @upstream_ledger.PrivacyAccount::new(
    "release", "trusted-holder", available, 1,
  )
  match ledger.register_account(account) {
    Ok(_) => ()
    Err(_) => raise KitError("upstream account rejected")
  }
  match ledger.reserve("admission", "release", cost) {
    Ok(_) => ()
    Err(_) => raise KitError("upstream reservation rejected")
  }
  match ledger.rollback("admission") {
    Ok(_) => ()
    Err(_) => raise KitError("upstream rollback rejected")
  }
  match ledger.reserve("release", "release", cost) {
    Ok(_) => ()
    Err(_) => raise KitError("upstream reservation rejected")
  }
  match ledger.commit("release") {
    Ok(_) => ()
    Err(_) => raise KitError("upstream commit rejected")
  }
  if !ledger.reconcile().is_healthy() {
    raise KitError("upstream reconciliation failed")
  }
}

///|
pub fn scan_sensitive_fields(
  format : String,
  input : String,
) -> Json raise KitError {
  let rows = planning_rows(format, input)
  let fields = record_fields(rows)
  let results : Array[Json] = []
  for name in fields {
    let counts : Map[String, Int32] = Map([])
    let mut affected = 0
    for row in rows {
      if row.get(name) is Some(String(value)) {
        let findings = @scrub.scan_with_config(
          value,
          @scrub.ScanConfig::standard(),
        )
        if !findings.is_empty() {
          affected += 1
        }
        for finding in findings {
          let kind = finding.kind.to_string()
          counts[kind] = counts.get(kind).unwrap_or(0) + 1
        }
      }
    }
    if affected > 0 {
      results.push({
        "field": Json(name),
        "affected_rows": Json(affected),
        "kinds": Json(counts),
      })
    }
  }
  {
    "schema_version": 1,
    "kind": "moonprivacykit/private-scan",
    "engine": "123123213weqw/moon_scrub@0.5.2",
    "findings": Json(results),
    "private_analysis": true,
  }
}

///|
pub fn scrub_text(input : String) -> Json raise KitError {
  if input.length() > 2000000 {
    raise KitError("text exceeds scan limit")
  }
  let result = @scrub.redact_with_config(
    input,
    @scrub.ScanConfig::standard(),
    style=@scrub.RedactionStyle::Typed,
  )
  {
    "output": Json(result.text),
    "finding_count": Json(result.findings.length()),
    "engine": "123123213weqw/moon_scrub@0.5.2",
  }
}
