//! Zcash leg of Unpair.
//!
//! What this crate does:
//! - derives a fresh transparent landing address per swap from the user's own seed,
//! - talks to public lightwalletd servers with failover and a tip height cross-check,
//! - syncs a small wallet database so anchors and UTXOs are known,
//! - shields everything that lands on a landing address into Ironwood in one step
//!   (Ironwood is the live Orchard-protocol pool since NU6.3; same addresses and keys),
//! - estimates ZIP-317 fees in plain words before anything moves,
//! - optionally routes all of the above over Tor (feature `tor`).
//!
//! It builds for native targets and for the browser (`wasm32-unknown-unknown`).
//! Native builds talk gRPC with TLS and can prove Sapling. Browser builds talk
//! gRPC-web through a proxy and spend Ironwood only; see `prover::NoSapling`.
//!
//! The seed stays where the caller runs this code: the user's device, or the
//! operator's server for hosted swaps.

pub mod cache;
pub mod error;
pub mod fees;
pub mod keys;
pub mod lightwalletd;
pub mod prover;
pub mod send;
#[cfg(all(feature = "tor", not(target_family = "wasm")))]
pub mod tor;
pub mod wallet;

pub use error::Error;
pub use zcash_protocol::consensus::{BlockHeight, Network};
pub use zcash_protocol::value::Zatoshis;
