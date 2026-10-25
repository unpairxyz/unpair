//! Derive landing addresses from a seed phrase without touching the network.
//!
//! UNPAIR_PHRASE="word word ..." cargo run -p unpair-zcash --example landing -- 3

use unpair_zcash::keys::{landing_at, spending_key, Seed};
use unpair_zcash::Network;
use zip32::DiversifierIndex;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let phrase = std::env::var("UNPAIR_PHRASE").expect("set UNPAIR_PHRASE to a BIP-39 phrase");
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let network = Network::MainNetwork;
    let seed = Seed::from_phrase(&phrase)?;
    let ufvk = spending_key(&network, &seed, 0)?.to_unified_full_viewing_key();
    let mut j = DiversifierIndex::new();
    for _ in 0..count {
        let l = landing_at(&ufvk, j)?;
        println!("index {:?}", l.index);
        println!("  landing   {}", l.transparent_string(&network));
        println!("  unified   {}", l.unified_string(&network));
        j = l.index;
        j.increment().map_err(|_| "diversifier space exhausted")?;
    }
    Ok(())
}
