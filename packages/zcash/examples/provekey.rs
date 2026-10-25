//! Time the Ironwood proving key build on this machine. Run in release:
//! `cargo run -p unpair-zcash --release --example provekey`

fn main() {
    let first = unpair_zcash::wallet::warm_proving_key();
    let second = unpair_zcash::wallet::warm_proving_key();
    println!("proving key build: {:.2} s", first.as_secs_f64());
    println!("cached call: {:.4} s", second.as_secs_f64());
}
