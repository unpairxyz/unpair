//! lightwalletd access with failover.
//!
//! We run no node. We talk to two or three public lightwalletd servers, pick
//! one, and cross-check its chain tip against the others. A server whose tip
//! lags the best one by more than `max_tip_lag` blocks is not used. Every call
//! goes through `Pool::with_client`, which tries each healthy endpoint in turn.

use std::time::Duration;

use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::proto::service::{
    ChainSpec, GetAddressUtxosArg, GetAddressUtxosReply, RawTransaction, SendResponse, TreeState,
    TxFilter,
};
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::error::Error;

pub type Client = CompactTxStreamerClient<Channel>;

/// Public mainnet servers. Operators and uptime change; keep this list short
/// and let deployments override it.
pub const MAINNET_ENDPOINTS: &[&str] = &[
    "https://zec.rocks:443",
    "https://na.zec.rocks:443",
    "https://eu.zec.rocks:443",
];

pub const TESTNET_ENDPOINTS: &[&str] = &["https://testnet.zec.rocks:443"];

pub fn default_endpoints(network: Network) -> Vec<String> {
    match network {
        Network::MainNetwork => MAINNET_ENDPOINTS.iter().map(|s| s.to_string()).collect(),
        Network::TestNetwork => TESTNET_ENDPOINTS.iter().map(|s| s.to_string()).collect(),
    }
}

/// How a gRPC channel is opened. Clearnet here; `tor::TorLightwalletd` implements
/// the same shape over arti.
#[async_trait::async_trait]
pub trait Connector: Send + Sync {
    async fn connect(&self, endpoint: &str) -> Result<Client, Error>;
}

/// Direct TLS connection. Leaks the caller's IP to the server.
#[derive(Clone, Debug)]
pub struct ClearnetConnector {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

impl Default for ClearnetConnector {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(60),
        }
    }
}

#[async_trait::async_trait]
impl Connector for ClearnetConnector {
    async fn connect(&self, endpoint: &str) -> Result<Client, Error> {
        let mut ep = Endpoint::from_shared(endpoint.to_string())
            .map_err(Error::lwd)?
            .connect_timeout(self.connect_timeout)
            .timeout(self.request_timeout);
        if endpoint.starts_with("https://") {
            ep = ep
                .tls_config(ClientTlsConfig::new().with_webpki_roots())
                .map_err(Error::lwd)?;
        }
        let channel = ep.connect().await.map_err(Error::lwd)?;
        Ok(CompactTxStreamerClient::new(channel))
    }
}

#[derive(Clone, Debug)]
pub struct TipReport {
    pub endpoint: String,
    pub height: Option<BlockHeight>,
    pub error: Option<String>,
}

/// A set of endpoints with health tracking.
pub struct Pool<C: Connector> {
    endpoints: Vec<String>,
    connector: C,
    /// Endpoints whose tip lags the best by more than this are skipped.
    pub max_tip_lag: u64,
    /// Order in which endpoints are tried. Rotated on failure.
    order: std::sync::Mutex<Vec<usize>>,
}

impl<C: Connector> Pool<C> {
    pub fn new(endpoints: Vec<String>, connector: C) -> Result<Self, Error> {
        if endpoints.is_empty() {
            return Err(Error::Lightwalletd("no endpoints configured".into()));
        }
        let order = (0..endpoints.len()).collect();
        Ok(Self {
            endpoints,
            connector,
            max_tip_lag: 3,
            order: std::sync::Mutex::new(order),
        })
    }

    pub fn endpoints(&self) -> &[String] {
        &self.endpoints
    }

    fn current_order(&self) -> Vec<usize> {
        self.order
            .lock()
            .map(|o| o.clone())
            .unwrap_or_else(|_| (0..self.endpoints.len()).collect())
    }

    fn demote(&self, idx: usize) {
        if let Ok(mut o) = self.order.lock() {
            if let Some(pos) = o.iter().position(|&i| i == idx) {
                let v = o.remove(pos);
                o.push(v);
            }
        }
    }

    /// Ask every endpoint for its tip. Never fails; errors are in the report.
    pub async fn tips(&self) -> Vec<TipReport> {
        let mut out = Vec::with_capacity(self.endpoints.len());
        for ep in &self.endpoints {
            let report = match self.connector.connect(ep).await {
                Ok(mut c) => match c.get_latest_block(ChainSpec {}).await {
                    Ok(resp) => TipReport {
                        endpoint: ep.clone(),
                        height: Some(BlockHeight::from_u32(resp.into_inner().height as u32)),
                        error: None,
                    },
                    Err(e) => TipReport {
                        endpoint: ep.clone(),
                        height: None,
                        error: Some(e.to_string()),
                    },
                },
                Err(e) => TipReport {
                    endpoint: ep.clone(),
                    height: None,
                    error: Some(e.to_string()),
                },
            };
            out.push(report);
        }
        out
    }

    /// The best tip across healthy endpoints, after checking they agree.
    /// Returns the tip and the endpoints that are within `max_tip_lag` of it.
    pub async fn checked_tip(&self) -> Result<(BlockHeight, Vec<String>), Error> {
        let reports = self.tips().await;
        let best = reports.iter().filter_map(|r| r.height).max();
        let Some(best) = best else {
            let last = reports
                .iter()
                .filter_map(|r| r.error.clone())
                .next_back()
                .unwrap_or_default();
            return Err(Error::AllEndpointsFailed(last));
        };
        let healthy: Vec<String> = reports
            .iter()
            .filter(|r| {
                r.height.is_some_and(|h| {
                    u64::from(u32::from(best)) - u64::from(u32::from(h)) <= self.max_tip_lag
                })
            })
            .map(|r| r.endpoint.clone())
            .collect();
        // Reorder so healthy endpoints go first.
        if let Ok(mut o) = self.order.lock() {
            o.sort_by_key(|&i| !healthy.contains(&self.endpoints[i]));
        }
        if healthy.len() == 1 && reports.iter().filter(|r| r.height.is_some()).count() > 1 {
            let worst = reports
                .iter()
                .filter_map(|r| r.height)
                .min()
                .unwrap_or(best);
            tracing::warn!(
                lag = u32::from(best) - u32::from(worst),
                "lightwalletd endpoints disagree on the tip"
            );
        }
        Ok((best, healthy))
    }

    /// Run `f` against the first endpoint that connects and answers. On failure
    /// the endpoint is demoted and the next one is tried.
    pub async fn with_client<T, F, Fut>(&self, mut f: F) -> Result<T, Error>
    where
        F: FnMut(Client) -> Fut,
        Fut: std::future::Future<Output = Result<T, Error>>,
    {
        let mut last = String::from("no endpoints");
        for idx in self.current_order() {
            let ep = &self.endpoints[idx];
            match self.connector.connect(ep).await {
                Ok(client) => match f(client).await {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        tracing::warn!(endpoint = %ep, error = %e, "lightwalletd call failed, trying next");
                        last = format!("{ep}: {e}");
                        self.demote(idx);
                    }
                },
                Err(e) => {
                    tracing::warn!(endpoint = %ep, error = %e, "lightwalletd connect failed, trying next");
                    last = format!("{ep}: {e}");
                    self.demote(idx);
                }
            }
        }
        Err(Error::AllEndpointsFailed(last))
    }

    /// Open a channel to one named endpoint.
    pub async fn connect(&self, endpoint: &str) -> Result<Client, Error> {
        self.connector.connect(endpoint).await
    }

    pub async fn latest_height(&self) -> Result<BlockHeight, Error> {
        self.with_client(|mut c| async move {
            let b = c
                .get_latest_block(ChainSpec {})
                .await
                .map_err(Error::lwd)?
                .into_inner();
            Ok(BlockHeight::from_u32(b.height as u32))
        })
        .await
    }

    pub async fn tree_state(&self, height: BlockHeight) -> Result<TreeState, Error> {
        self.with_client(|mut c| async move {
            let id = zcash_client_backend::proto::service::BlockId {
                height: u64::from(u32::from(height)),
                hash: vec![],
            };
            Ok(c.get_tree_state(id).await.map_err(Error::lwd)?.into_inner())
        })
        .await
    }

    /// Unspent outputs on the given transparent addresses (encoded strings).
    pub async fn address_utxos(
        &self,
        addresses: Vec<String>,
        start_height: BlockHeight,
    ) -> Result<Vec<GetAddressUtxosReply>, Error> {
        self.with_client(|mut c| {
            let addresses = addresses.clone();
            async move {
                let arg = GetAddressUtxosArg {
                    addresses,
                    start_height: u64::from(u32::from(start_height)),
                    max_entries: 0,
                };
                Ok(c.get_address_utxos(arg)
                    .await
                    .map_err(Error::lwd)?
                    .into_inner()
                    .address_utxos)
            }
        })
        .await
    }

    /// Broadcast a serialised transaction. Returns the server's response; a
    /// non-zero `error_code` means the node rejected it.
    pub async fn send_raw_transaction(&self, raw: Vec<u8>) -> Result<SendResponse, Error> {
        self.with_client(|mut c| {
            let raw = raw.clone();
            async move {
                let resp = c
                    .send_transaction(RawTransaction {
                        data: raw,
                        height: 0,
                    })
                    .await
                    .map_err(Error::lwd)?
                    .into_inner();
                if resp.error_code != 0 {
                    return Err(Error::Lightwalletd(format!(
                        "broadcast rejected ({}): {}",
                        resp.error_code, resp.error_message
                    )));
                }
                Ok(resp)
            }
        })
        .await
    }

    /// Fetch a transaction by id. Used to confirm a shield was mined.
    pub async fn transaction(&self, txid: [u8; 32]) -> Result<RawTransaction, Error> {
        self.with_client(|mut c| async move {
            Ok(c.get_transaction(TxFilter {
                block: None,
                index: 0,
                hash: txid.to_vec(),
            })
            .await
            .map_err(Error::lwd)?
            .into_inner())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_https() {
        for ep in default_endpoints(Network::MainNetwork)
            .iter()
            .chain(default_endpoints(Network::TestNetwork).iter())
        {
            assert!(ep.starts_with("https://"), "{ep}");
        }
    }

    #[test]
    fn empty_pool_is_an_error() {
        assert!(Pool::new(vec![], ClearnetConnector::default()).is_err());
    }

    struct FailingConnector;
    #[async_trait::async_trait]
    impl Connector for FailingConnector {
        async fn connect(&self, endpoint: &str) -> Result<Client, Error> {
            Err(Error::Lightwalletd(format!("refused {endpoint}")))
        }
    }

    #[tokio::test]
    async fn all_failures_report_last_error_and_rotate() {
        let pool = Pool::new(
            vec!["https://a".into(), "https://b".into()],
            FailingConnector,
        )
        .unwrap();
        let err = pool.latest_height().await.unwrap_err();
        assert!(
            matches!(err, Error::AllEndpointsFailed(ref m) if m.contains("https://b")),
            "{err}"
        );
        let tips = pool.tips().await;
        assert_eq!(tips.len(), 2);
        assert!(tips.iter().all(|t| t.height.is_none() && t.error.is_some()));
        assert!(matches!(
            pool.checked_tip().await,
            Err(Error::AllEndpointsFailed(_))
        ));
    }
}
