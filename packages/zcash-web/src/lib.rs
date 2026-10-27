//! Unpair's Zcash wallet for the browser.
//!
//! One `WebWallet` is one swap. It makes a fresh seed, hands out a
//! shielded-only landing address for the route to pay, scans the chain from
//! the moment it was created, and spends the landed note on to the next
//! route's address. The seed never leaves the page; the caller is expected to
//! offer it to the user as a recovery file before the deposit is sent.
//!
//! Network access goes through a gRPC-web proxy in front of lightwalletd,
//! because browsers cannot speak gRPC. The proxy sees the page's IP and the
//! block ranges it asks for, never a key or a note.
#![cfg(target_family = "wasm")]

use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use unpair_zcash::keys::{orchard_only_at, Seed};
use unpair_zcash::lightwalletd::{Pool, WebConnector};
use unpair_zcash::send::upgrade_notice;
use unpair_zcash::wallet::{ShieldPolicy, ShieldWallet};
use unpair_zcash::{BlockHeight, Network, Zatoshis};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    // INFO keeps the sync progress in the console; TRACE floods it.
    let config = tracing_wasm::WASMLayerConfigBuilder::new()
        .set_max_level(tracing::Level::INFO)
        .build();
    tracing_wasm::set_as_global_default_with_config(config);
}

/// A landing for one swap.
#[derive(Serialize)]
pub struct Landing {
    /// Orchard-only unified address. The route pays this; it lands in Ironwood.
    pub shielded: String,
    /// Transparent receiver at the same index, for a refund of the second hop.
    pub transparent: String,
    pub index: u32,
}

#[derive(Serialize)]
pub struct Balance {
    pub ironwood_spendable: u64,
    pub ironwood_notes: u64,
    pub hop2_reserve: u64,
    pub ironwood_total: u64,
    pub unshielded: u64,
    pub chain_tip: Option<u32>,
    pub scanned_to: Option<u32>,
}

#[derive(Serialize)]
pub struct Payout {
    pub txid: String,
    pub fee: u64,
    /// Set when the transaction was built but the broadcast failed. It may
    /// still be on the chain; the page keeps the txid and watches.
    pub broadcast_error: Option<String>,
}

#[derive(Serialize)]
pub struct Upgrade {
    pub name: &'static str,
    pub height: u32,
    pub blocks_left: u32,
    pub eta_unix: u64,
    pub sending_paused: bool,
}

fn js_err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

fn network(name: &str) -> Result<Network, JsError> {
    match name {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => Err(JsError::new(&format!(
            "unknown network {other}; use main or test"
        ))),
    }
}

/// A per-swap wallet in the page. Not `Send`: it lives on the main thread or
/// in one worker, and every call runs there.
#[wasm_bindgen]
pub struct WebWallet {
    phrase: SecretString,
    wallet: ShieldWallet,
    pool: Pool<WebConnector>,
    network: Network,
    birthday: u32,
}

#[wasm_bindgen]
impl WebWallet {
    /// Open a wallet. With no `phrase`, make a fresh seed and start scanning
    /// from the chain tip. With a phrase from a recovery file, start from
    /// `birthday_height`, the height the file recorded.
    #[wasm_bindgen]
    pub async fn open(
        network_name: &str,
        grpc_web_url: &str,
        phrase: Option<String>,
        birthday_height: Option<u32>,
    ) -> Result<WebWallet, JsError> {
        let network = network(network_name)?;
        let (phrase, seed) = match phrase {
            Some(p) => {
                let seed = Seed::from_phrase(p.trim()).map_err(js_err)?;
                (p, seed)
            }
            None => Seed::generate(),
        };
        let pool = Pool::new(vec![grpc_web_url.to_string()], WebConnector).map_err(js_err)?;
        let (tip, _) = pool.checked_tip().await.map_err(js_err)?;
        let birth = match birthday_height {
            Some(h) if BlockHeight::from(h) < tip => BlockHeight::from(h),
            _ => tip,
        };
        let birthday = pool.tree_state(birth).await.map_err(js_err)?;
        let db_name = match network {
            Network::MainNetwork => "unpair-main.db",
            Network::TestNetwork => "unpair-test.db",
        };
        let wallet = ShieldWallet::open(
            network,
            std::path::Path::new(db_name),
            &seed,
            birthday,
            ShieldPolicy::default(),
        )
        .map_err(js_err)?;
        Ok(WebWallet {
            phrase: SecretString::new(phrase),
            wallet,
            pool,
            network,
            birthday: u32::from(birth),
        })
    }

    /// The 24 words. Show them once, write them to the recovery file, and
    /// do not keep them in page state.
    #[wasm_bindgen(js_name = recoveryPhrase)]
    pub fn recovery_phrase(&self) -> String {
        self.phrase.expose_secret().clone()
    }

    /// The height this wallet scans from. Goes into the recovery file.
    #[wasm_bindgen(js_name = birthdayHeight)]
    pub fn birthday_height(&self) -> u32 {
        self.birthday
    }

    /// A fresh landing. One per swap.
    #[wasm_bindgen(js_name = nextLanding)]
    pub fn next_landing(&mut self) -> Result<JsValue, JsError> {
        let l = self.wallet.next_landing().map_err(js_err)?;
        let (shielded, index) = orchard_only_at(self.wallet.ufvk(), l.index).map_err(js_err)?;
        if index != l.index {
            return Err(JsError::new(
                "shielded and transparent receivers are at different indexes",
            ));
        }
        let out = Landing {
            shielded: shielded.encode(&self.network),
            transparent: l.transparent_string(&self.network),
            index: u32::try_from(l.index).unwrap_or(u32::MAX),
        };
        serde_wasm_bindgen::to_value(&out).map_err(js_err)
    }

    /// Download and scan to the chain tip. Returns the tip height.
    #[wasm_bindgen]
    pub async fn sync(&mut self) -> Result<u32, JsError> {
        let tip = self.wallet.sync(&self.pool).await.map_err(js_err)?;
        Ok(u32::from(tip))
    }

    #[wasm_bindgen]
    pub fn balance(&self) -> Result<JsValue, JsError> {
        let b = self.wallet.balance().map_err(js_err)?;
        let out = Balance {
            ironwood_spendable: b.ironwood_spendable,
            ironwood_notes: b.ironwood_notes,
            hop2_reserve: b.hop2_reserve,
            ironwood_total: b.ironwood_total,
            unshielded: b.unshielded,
            chain_tip: b.chain_tip,
            scanned_to: b.scanned_to,
        };
        serde_wasm_bindgen::to_value(&out).map_err(js_err)
    }

    /// Shield anything that landed on a transparent receiver (a second-hop
    /// refund). Returns the txids broadcast.
    #[wasm_bindgen]
    pub async fn shield(&mut self) -> Result<JsValue, JsError> {
        let from = self.wallet.known_landings().map_err(js_err)?;
        let txids = match self.wallet.sync_and_shield(&self.pool, &from).await {
            Ok(t) => t,
            Err(unpair_zcash::Error::NothingToShield) => Vec::new(),
            Err(e) => return Err(js_err(e)),
        };
        let out: Vec<String> = txids.iter().map(|t| t.to_string()).collect();
        serde_wasm_bindgen::to_value(&out).map_err(js_err)
    }

    /// Hop two: pay `zatoshis` to the transparent address `to` from Ironwood
    /// notes, and broadcast. Proving runs here and takes a while in a browser.
    #[wasm_bindgen]
    pub async fn pay(&mut self, to: &str, zatoshis: u64) -> Result<JsValue, JsError> {
        let amount =
            Zatoshis::from_u64(zatoshis).map_err(|_| JsError::new("amount out of range"))?;
        let p = self
            .wallet
            .sync_and_pay(&self.pool, to, amount)
            .await
            .map_err(js_err)?;
        let out = Payout {
            txid: p.txid.to_string(),
            fee: p.fee.into_u64(),
            broadcast_error: p.broadcast_error,
        };
        serde_wasm_bindgen::to_value(&out).map_err(js_err)
    }

    /// The next network upgrade, if one is close enough to matter.
    #[wasm_bindgen(js_name = upgradeNotice)]
    pub fn upgrade_notice(&self, tip: u32, now_unix: u64) -> Result<JsValue, JsError> {
        let out =
            upgrade_notice(&self.network, BlockHeight::from(tip), now_unix).map(|u| Upgrade {
                name: u.name,
                height: u.height,
                blocks_left: u.blocks_left,
                eta_unix: u.eta_unix,
                sending_paused: u.sending_paused,
            });
        serde_wasm_bindgen::to_value(&out).map_err(js_err)
    }
}
