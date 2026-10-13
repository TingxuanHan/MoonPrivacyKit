///|
pub fn dispatch(input : String) -> String {
  @kit.dispatch(input)
}

///|
pub fn dispatch_central(
  input : String,
  random_below : (Int32) -> Int32,
) -> String {
  @kit.dispatch_central(input, random_below)
}

///|
fn main {
  ()
}
