//! The shielding wallet.
//!
//! One account. Fresh landing address per swap. Sync against lightwalletd.
//! Shield everything on the landing addresses into Ironwood in one step.
//! Ironwood is the active Orchard-protocol pool since NU6.3 (July 2026);
//! the old Orchard pool accepts no new value.
//! The seed never leaves this process.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use rand::rngs::SysRng;
use rand_core::{Infallible, TryCryptoRng, TryRng};
use zcash_client_backend::data_api::wallet::input_selection::{GreedyInputSelector, SpendPolicy};
use zcash_client_backend::data_api::wallet::{
    create_proposed_transactions, propose_shielding, propose_transfer, ConfirmationsPolicy,
    SpendingKeys,
};
use zcash_client_backend::data_api::{
    Account as _, AccountBirthday, CoinbaseFilter, WalletRead, WalletWrite,
};
use zcash_client_backend::fees::zip317::SingleOutputChangeStrategy;
use zcash_client_backend::fees::{DustOutputPolicy, StandardFeeRule};
use zcash_client_backend::proto::service::TreeState;
use zcash_client_backend::sync;
#[cfg(not(target_family = "wasm"))]
use zcash_client_backend::util::SystemClock;
#[cfg(not(target_family = "wasm"))]
use zcash_client_backend::wallet::{Note, OvkPolicy};
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_client_sqlite::{AccountUuid, WalletDb};
use zcash_keys::keys::ReceiverRequirement::{Omit, Require};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_primitives::transaction::TxId;
#[cfg(not(target_family = "wasm"))]
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::{BlockHeight, Network};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::{PoolType, ShieldedPool};
use zcash_transparent::address::TransparentAddress;

use crate::cache::MemBlockCache;
use crate::error::Error;
use crate::keys::{spending_key, Landing, Seed};
use crate::lightwalletd::{Connector, Pool};
use crate::send::{check_payout_address, upgrade_guard};

/// The operating system's random source as an infallible RNG. It is `Send`,
/// `Sync` and `Clone`, so a `ShieldWallet` can move to a blocking thread for
/// proving. A failing OS random source is fatal, as it is for the thread RNG.
#[derive(Clone, Copy, Debug, Default)]
pub struct OsRng;

impl TryRng for OsRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        Ok(SysRng.try_next_u32().expect("OS random source failed"))
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        Ok(SysRng.try_next_u64().expect("OS random source failed"))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        SysRng.try_fill_bytes(dst).expect("OS random source failed");
        Ok(())
    }
}

impl TryCryptoRng for OsRng {}

/// The wallet database.
/// The wallet's clock: the system clock natively, `Date.now()` in the browser,
/// where `SystemTime::now()` is not available.
#[cfg(not(target_family = "wasm"))]
pub type Clock = SystemClock;
#[cfg(target_family = "wasm")]
pub type Clock = WebClock;

#[cfg(target_family = "wasm")]
#[derive(Clone, Copy, Debug, Default)]
pub struct WebClock;

#[cfg(target_family = "wasm")]
impl zcash_client_backend::util::Clock for WebClock {
    fn now(&self) -> std::time::SystemTime {
        let ms = js_sys::Date::now().max(0.0) as u64;
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms)
    }
}

#[cfg(not(target_family = "wasm"))]
fn clock() -> Clock {
    SystemClock
}
#[cfg(target_family = "wasm")]
fn clock() -> Clock {
    WebClock
}

pub type Db = WalletDb<rusqlite::Connection, Network, Clock, OsRng>;

/// Policy knobs with safe defaults.
#[derive(Clone, Debug)]
pub struct ShieldPolicy {
    /// Confirmations before a landing UTXO may be shielded. Default 1.
    pub min_confirmations: NonZeroU32,
    /// Do not shield below this. Dust shields cost more than they move. Default 0.0005 ZEC.
    pub shielding_threshold: Zatoshis,
    /// Blocks per sync batch. Default 1000.
    pub sync_batch_size: u32,
}

impl Default for ShieldPolicy {
    fn default() -> Self {
        Self {
            min_confirmations: NonZeroU32::new(1).unwrap(),
            shielding_threshold: Zatoshis::const_from_u64(50_000),
            sync_batch_size: 1000,
        }
    }
}

/// Account value by pool, in zatoshis. Only Ironwood is spendable by Unpair.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Balance {
    pub ironwood_spendable: u64,
    pub ironwood_total: u64,
    pub orchard_total: u64,
    pub sapling_total: u64,
    pub unshielded: u64,
    pub chain_tip: Option<u32>,
    pub scanned_to: Option<u32>,
}

/// A built hop-two transaction, ready to broadcast.
#[derive(Clone, Debug)]
pub struct Payout {
    pub txid: TxId,
    pub raw: Vec<u8>,
    pub fee: Zatoshis,
}

/// Build the Ironwood proving key and keep it in the process-wide cache that
/// the transaction builder uses. The first call takes seconds of CPU; later
/// calls return at once. Returns how long the call took.
pub fn warm_proving_key() -> std::time::Duration {
    let start = std::time::Instant::now();
    let _ = zcash_primitives::transaction::builder::cached_orchard_proving_key(
        orchard::circuit::OrchardCircuitVersion::PostNu6_3,
    );
    start.elapsed()
}

pub struct ShieldWallet {
    network: Network,
    db: Db,
    account: AccountUuid,
    usk: UnifiedSpendingKey,
    ufvk: UnifiedFullViewingKey,
    cache: MemBlockCache,
    policy: ShieldPolicy,
    params_dir: Option<PathBuf>,
}

impl ShieldWallet {
    /// Open or create the wallet database at `db_path` for `seed`, account 0.
    /// `birthday` is the chain state the account starts from. For a new wallet
    /// use the current tip's tree state from `Pool::tree_state`.
    pub fn open(
        network: Network,
        db_path: &Path,
        seed: &Seed,
        birthday: TreeState,
        policy: ShieldPolicy,
    ) -> Result<Self, Error> {
        let mut db = WalletDb::for_path(db_path, network, clock(), OsRng).map_err(Error::wallet)?;
        init_wallet_db(&mut db, Some(seed.secret_vec())).map_err(Error::wallet)?;

        let usk = spending_key(&network, seed, 0)?;
        let ufvk = usk.to_unified_full_viewing_key();

        let account = match db.get_account_for_ufvk(&ufvk).map_err(Error::wallet)? {
            Some(acct) => acct.id(),
            None => {
                let birthday = AccountBirthday::from_treestate(birthday, None)
                    .map_err(|e| Error::Wallet(format!("{e:?}")))?;
                let (id, created) = db
                    .create_account("unpair", &seed.secret_vec(), &birthday, None)
                    .map_err(Error::wallet)?;
                if created.to_unified_full_viewing_key().encode(&network) != ufvk.encode(&network) {
                    return Err(Error::Wallet(
                        "created account key does not match derived key".into(),
                    ));
                }
                id
            }
        };

        Ok(Self {
            network,
            db,
            account,
            usk,
            ufvk,
            cache: MemBlockCache::new(),
            policy,
            params_dir: None,
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn ufvk(&self) -> &UnifiedFullViewingKey {
        &self.ufvk
    }

    /// Where Sapling proving parameters live. Default: zcash_proofs' default folder.
    pub fn with_params_dir(mut self, dir: PathBuf) -> Self {
        self.params_dir = Some(dir);
        self
    }

    /// The next unused landing address. Each call advances the account's
    /// address index, so no two swaps share an address.
    pub fn next_landing(&mut self) -> Result<Landing, Error> {
        let (ua, index) = self
            .db
            .get_next_available_address(
                self.account,
                UnifiedAddressRequest::unsafe_custom(Require, Omit, Require),
            )
            .map_err(Error::wallet)?
            .ok_or_else(|| Error::Address("no address available for account".into()))?;
        let transparent = *ua
            .transparent()
            .ok_or_else(|| Error::Address("address has no transparent receiver".into()))?;
        if !ua.has_orchard() {
            return Err(Error::Address(
                "address has no Orchard receiver (Ironwood shares it)".into(),
            ));
        }
        Ok(Landing {
            index,
            transparent,
            unified: ua,
        })
    }

    /// All transparent receivers the wallet knows for this account.
    pub fn known_landings(&self) -> Result<Vec<TransparentAddress>, Error> {
        Ok(self
            .db
            .get_transparent_receivers(self.account, false, false)
            .map_err(Error::wallet)?
            .into_keys()
            .collect())
    }

    /// Download and scan until the wallet is at the chain tip. Also refreshes
    /// transparent UTXOs on the account's addresses. Idempotent.
    pub async fn sync<C: Connector>(&mut self, pool: &Pool<C>) -> Result<BlockHeight, Error> {
        let (tip, healthy) = pool.checked_tip().await?;
        if healthy.is_empty() {
            return Err(Error::Sync("no healthy lightwalletd endpoint".into()));
        }
        let network = self.network;
        let batch = self.policy.sync_batch_size;
        let mut last = String::new();
        for endpoint in &healthy {
            let mut client = match pool.connect(endpoint).await {
                Ok(c) => c,
                Err(e) => {
                    last = format!("{endpoint}: {e}");
                    continue;
                }
            };
            match sync::run(&mut client, &network, &self.cache, &mut self.db, batch).await {
                Ok(()) => return Ok(tip),
                Err(e) => {
                    tracing::warn!(endpoint = %endpoint, error = ?e, "sync failed, trying next endpoint");
                    last = format!("{endpoint}: {e:?}");
                }
            }
        }
        Err(Error::Sync(last))
    }

    /// Sapling prover for the transaction builder. Native builds load or
    /// download the Sapling parameters. Browser builds spend Ironwood only and
    /// use [`crate::prover::NoSapling`], which never has to prove anything.
    #[cfg(not(target_family = "wasm"))]
    fn prover(&self) -> Result<LocalTxProver, Error> {
        if let Some(dir) = &self.params_dir {
            let spend = dir.join("sapling-spend.params");
            let output = dir.join("sapling-output.params");
            if spend.exists() && output.exists() {
                return Ok(LocalTxProver::new(&spend, &output));
            }
            return Err(Error::Params(format!(
                "missing sapling params in {}",
                dir.display()
            )));
        }
        if let Some(p) = LocalTxProver::with_default_location() {
            return Ok(p);
        }
        tracing::info!("downloading Sapling proving parameters");
        zcash_proofs::download_sapling_parameters(Some(120))
            .map_err(|e| Error::Params(e.to_string()))?;
        LocalTxProver::with_default_location()
            .ok_or_else(|| Error::Params("parameters not found after download".into()))
    }

    #[cfg(target_family = "wasm")]
    fn prover(&self) -> Result<crate::prover::NoSapling, Error> {
        Ok(crate::prover::NoSapling)
    }

    fn confirmations(&self) -> ConfirmationsPolicy {
        let n = self.policy.min_confirmations;
        ConfirmationsPolicy::new(n, n, false).expect("equal trusted and untrusted is valid")
    }

    /// Build, prove, sign and store a transaction that moves every spendable
    /// UTXO on `from` into this account's Ironwood pool. Returns the txids and
    /// the serialised transactions, ready for `Pool::send_raw_transaction`.
    /// Call `sync` first.
    pub fn shield(&mut self, from: &[TransparentAddress]) -> Result<Vec<(TxId, Vec<u8>)>, Error> {
        if from.is_empty() {
            return Err(Error::NothingToShield);
        }
        let confirmations = self.confirmations();
        let threshold = self.policy.shielding_threshold;
        let account = self.account;
        let network = self.network;
        let selector = GreedyInputSelector::<Db>::new();
        let change = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );
        let proposal = propose_shielding::<
            Db,
            Network,
            GreedyInputSelector<Db>,
            SingleOutputChangeStrategy<StandardFeeRule, Db>,
            std::convert::Infallible,
        >(
            &mut self.db,
            &network,
            &selector,
            &change,
            threshold,
            from,
            account,
            confirmations,
            CoinbaseFilter::default(),
            None,
        )
        .map_err(|e| {
            let text = format!("{e:?}");
            if text.contains("InsufficientFunds") || text.contains("NoSpendableFunds") {
                Error::NothingToShield
            } else {
                Error::Shield(text)
            }
        })?;

        let prover = self.prover()?;
        let keys = SpendingKeys::from_unified_spending_key(self.usk.clone());
        let mut rng = rand::rng();
        let txids = create_proposed_transactions::<
            Db,
            Network,
            std::convert::Infallible,
            StandardFeeRule,
            std::convert::Infallible,
            std::convert::Infallible,
        >(
            &mut self.db,
            &self.network,
            &clock(),
            &mut rng,
            &prover,
            &prover,
            &keys,
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| Error::Shield(format!("{e:?}")))?;

        let mut out = Vec::with_capacity(txids.len());
        for txid in txids {
            let tx = self
                .db
                .get_transaction(txid)
                .map_err(Error::wallet)?
                .ok_or_else(|| {
                    Error::Shield(format!("built transaction {txid} not found in wallet"))
                })?;
            let mut raw = Vec::new();
            tx.write(&mut raw)?;
            out.push((txid, raw));
        }
        Ok(out)
    }

    /// Spendable and pending value in this account, by pool.
    pub fn balance(&self) -> Result<Balance, Error> {
        let summary = self
            .db
            .get_wallet_summary(ConfirmationsPolicy::default())
            .map_err(Error::wallet)?;
        let Some(summary) = summary else {
            return Ok(Balance::default());
        };
        let mut b = Balance {
            chain_tip: Some(u32::from(summary.chain_tip_height())),
            scanned_to: Some(u32::from(summary.fully_scanned_height())),
            ..Default::default()
        };
        if let Some(a) = summary.account_balances().get(&self.account) {
            b.ironwood_spendable = a.ironwood_balance().spendable_value().into_u64();
            b.ironwood_total = a.ironwood_balance().total().into_u64();
            b.orchard_total = a.orchard_balance().total().into_u64();
            b.sapling_total = a.sapling_balance().total().into_u64();
            b.unshielded = a.unshielded_balance().total().into_u64();
        }
        Ok(b)
    }

    /// Hop two. Build, prove, sign and store a transaction that pays `amount`
    /// to the transparent address `to` from Ironwood notes only, with change
    /// back to Ironwood. Returns the txid, the serialised transaction and the
    /// fee paid. Call `sync` first. Refuses within [`crate::send::UPGRADE_GUARD_BLOCKS`]
    /// of a network upgrade.
    pub fn pay_transparent(&mut self, to: &str, amount: Zatoshis) -> Result<Payout, Error> {
        let network = self.network;
        let recipient = check_payout_address(&network, to)?;
        if let Some(tip) = self.db.chain_height().map_err(Error::wallet)? {
            upgrade_guard(&network, tip)?;
        }
        let request =
            zip321::TransactionRequest::new(vec![zip321::Payment::without_memo(recipient, amount)])
                .map_err(|e| Error::Send(format!("{e:?}")))?;

        let selector = GreedyInputSelector::<Db>::new();
        let change = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );
        let spend_policy = SpendPolicy::shielded_pools([ShieldedPool::Ironwood]);
        let proposal = propose_transfer::<
            Db,
            Network,
            GreedyInputSelector<Db>,
            SingleOutputChangeStrategy<StandardFeeRule, Db>,
            std::convert::Infallible,
        >(
            &mut self.db,
            &network,
            self.account,
            &selector,
            &change,
            request,
            ConfirmationsPolicy::default(),
            &spend_policy,
            None,
            None,
        )
        .map_err(|e| {
            let text = format!("{e:?}");
            if text.contains("InsufficientFunds") {
                Error::InsufficientFunds
            } else {
                Error::Send(text)
            }
        })?;

        // The proposal must be the one shape we expect: one step, Ironwood
        // notes in, Ironwood change out, nothing transparent spent.
        if proposal.steps().len() != 1 {
            return Err(Error::Send(
                "the route needs more than one transaction".into(),
            ));
        }
        let step = proposal.steps().first();
        if !step.transparent_inputs().is_empty() {
            return Err(Error::Send("proposal spends transparent funds".into()));
        }
        if let Some(inputs) = step.shielded_inputs() {
            for n in inputs.notes().iter() {
                if !matches!(
                    n.note(),
                    Note::Orchard {
                        pool: orchard::ValuePool::Ironwood,
                        ..
                    }
                ) {
                    return Err(Error::Send(
                        "proposal spends a note outside Ironwood".into(),
                    ));
                }
            }
        }
        for c in step.balance().proposed_change() {
            if c.output_pool() != PoolType::IRONWOOD {
                return Err(Error::Send(format!(
                    "proposal sends change to {}",
                    c.output_pool()
                )));
            }
        }
        let fee = step.balance().fee_required();

        let prover = self.prover()?;
        let keys = SpendingKeys::from_unified_spending_key(self.usk.clone());
        let mut rng = rand::rng();
        let txids = create_proposed_transactions::<
            Db,
            Network,
            std::convert::Infallible,
            StandardFeeRule,
            std::convert::Infallible,
            zcash_client_sqlite::ReceivedNoteId,
        >(
            &mut self.db,
            &self.network,
            &clock(),
            &mut rng,
            &prover,
            &prover,
            &keys,
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| Error::Send(format!("{e:?}")))?;
        let txid = *txids.first();
        let tx = self
            .db
            .get_transaction(txid)
            .map_err(Error::wallet)?
            .ok_or_else(|| Error::Send(format!("built transaction {txid} not found in wallet")))?;
        let mut raw = Vec::new();
        tx.write(&mut raw)?;
        Ok(Payout { txid, raw, fee })
    }

    /// Sync, pay, broadcast. Hop two in one call.
    pub async fn sync_and_pay<C: Connector>(
        &mut self,
        pool: &Pool<C>,
        to: &str,
        amount: Zatoshis,
    ) -> Result<Payout, Error> {
        self.sync(pool).await?;
        let payout = self.pay_transparent(to, amount)?;
        pool.send_raw_transaction(payout.raw.clone()).await?;
        Ok(payout)
    }

    /// Sync, shield everything on `from`, broadcast. The one-step auto-shield.
    pub async fn sync_and_shield<C: Connector>(
        &mut self,
        pool: &Pool<C>,
        from: &[TransparentAddress],
    ) -> Result<Vec<TxId>, Error> {
        self.sync(pool).await?;
        let txs = self.shield(from)?;
        let mut sent = Vec::with_capacity(txs.len());
        for (txid, raw) in txs {
            pool.send_raw_transaction(raw).await?;
            tracing::info!(%txid, "shield broadcast");
            sent.push(txid);
        }
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_is_conservative() {
        let p = ShieldPolicy::default();
        assert_eq!(p.min_confirmations.get(), 1);
        assert_eq!(p.shielding_threshold.into_u64(), 50_000);
        let c = ConfirmationsPolicy::new(p.min_confirmations, p.min_confirmations, false);
        assert!(c.is_ok());
    }
}

#[cfg(test)]
mod send_check {
    use super::ShieldWallet;

    fn assert_send<T: Send>() {}

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn shield_wallet_is_send() {
        // Proving and scanning run on blocking threads in the app, so the wallet
        // must be movable between threads.
        assert_send::<ShieldWallet>();
    }
}
