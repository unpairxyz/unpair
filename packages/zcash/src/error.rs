use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("seed phrase is not valid: {0}")]
    Mnemonic(String),
    #[error("key derivation failed: {0}")]
    Derivation(String),
    #[error("address generation failed: {0}")]
    Address(String),
    #[error("lightwalletd: {0}")]
    Lightwalletd(String),
    #[error("every lightwalletd endpoint failed; last error: {0}")]
    AllEndpointsFailed(String),
    #[error("lightwalletd endpoints disagree on the chain tip by {0} blocks")]
    TipMismatch(u64),
    #[error("wallet database: {0}")]
    Wallet(String),
    #[error("sync: {0}")]
    Sync(String),
    #[error("nothing to shield: no spendable funds on the landing addresses")]
    NothingToShield,
    #[error("shielding: {0}")]
    Shield(String),
    #[error("proving parameters: {0}")]
    Params(String),
    #[error("payout address: {0}")]
    PayoutAddress(String),
    #[error("not enough spendable ZEC in Ironwood for this payout")]
    InsufficientFunds,
    #[error("sending: {0}")]
    Send(String),
    #[error("a network upgrade activates within {0} blocks; sending resumes after it")]
    UpgradeWindow(u32),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    pub(crate) fn wallet<E: std::fmt::Debug>(e: E) -> Self {
        Error::Wallet(format!("{e:?}"))
    }
    pub(crate) fn lwd<E: std::fmt::Display>(e: E) -> Self {
        Error::Lightwalletd(e.to_string())
    }
}
