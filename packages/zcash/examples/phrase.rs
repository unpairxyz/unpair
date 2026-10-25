//! Print a fresh 24 word phrase. For a transit wallet, run once, keep the
//! output offline, and never reuse it for anything else.
//!
//! cargo run -p unpair-zcash --example phrase

use unpair_zcash::keys::Seed;

fn main() {
    let (phrase, _seed) = Seed::generate();
    println!("{phrase}");
}
