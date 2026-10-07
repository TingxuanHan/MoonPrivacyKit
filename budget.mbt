///|
/// Exact accounting units: one unit is 0.000001 epsilon. Persistence and
/// transaction boundaries are the responsibility of the trusted host.
pub struct BudgetState {
  total_units : Int
  spent_units : Int
  remaining_units : Int
} derive(ToJson)

///|
pub fn make_budget_state(
  total_units : Int,
  spent_units : Int,
) -> BudgetState raise KitError {
  if total_units < 10_000 || total_units > 1_000_000_000 {
    raise KitError("total budget must be between 0.01 and 1000 epsilon")
  }
  if spent_units < 0 || spent_units > total_units {
    raise KitError("stored budget is outside its allowed range")
  }
  { total_units, spent_units, remaining_units: total_units - spent_units, }
}

///|
/// Charge the requested budget, not a rounded estimate of effective epsilon.
/// Check subtraction first so an invalid charge can never overflow a sum.
pub fn charge_budget(
  state : BudgetState,
  charge_units : Int,
) -> BudgetState raise KitError {
  if charge_units < 10_000 || charge_units > 8_000_000 {
    raise KitError("release budget must be between 0.01 and 8 epsilon")
  }
  if charge_units > state.remaining_units {
    raise KitError("privacy budget exhausted")
  }
  make_budget_state(state.total_units, state.spent_units + charge_units)
}

///|
pub extend BudgetState with ToJson::{to_json}
