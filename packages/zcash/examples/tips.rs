//! Ask every default lightwalletd endpoint for its chain tip and report which
//! ones agree. No keys, no funds.
//!
//! cargo run -p unpair-zcash --example tips

use unpair_zcash::lightwalletd::{default_endpoints, ClearnetConnector, Pool};
use unpair_zcash::Network;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = Pool::new(
        default_endpoints(Network::MainNetwork),
        ClearnetConnector::default(),
    )?;
    for t in pool.tips().await {
        match (t.height, t.error) {
            (Some(h), _) => println!("{:<28} tip {}", t.endpoint, u32::from(h)),
            (None, Some(e)) => println!("{:<28} error {e}", t.endpoint),
            (None, None) => println!("{:<28} no answer", t.endpoint),
        }
    }
    let (best, healthy) = pool.checked_tip().await?;
    println!(
        "best tip {} agreed by {} endpoint(s)",
        u32::from(best),
        healthy.len()
    );
    Ok(())
}
