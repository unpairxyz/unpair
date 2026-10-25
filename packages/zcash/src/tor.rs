//! Tor transport via arti. Enabled with the `tor` feature.
//!
//! `TorLightwalletd` is a `Connector`: every lightwalletd channel is opened
//! through the embedded Tor client, so servers see an exit node, not the user.

use std::path::Path;
use std::time::Duration;

use zcash_client_backend::tor;

use crate::error::Error;
use crate::lightwalletd::{Client, Connector};

pub struct TorLightwalletd {
    client: tor::Client,
    allow_onion: bool,
}

impl TorLightwalletd {
    /// Start a Tor client with state under `tor_dir`. The directory must exist.
    /// Bootstrapping happens on the first connection.
    pub async fn new(tor_dir: &Path) -> Result<Self, Error> {
        let timeouts = tor::Timeouts::default()
            .with_connect(Duration::from_secs(60))
            .with_request(Duration::from_secs(120));
        let client = tor::Client::create_with_timeouts(tor_dir, |_| {}, timeouts)
            .await
            .map_err(|e| Error::Lightwalletd(format!("tor: {e}")))?;
        Ok(Self { client, allow_onion: true })
    }
}

#[async_trait::async_trait]
impl Connector for TorLightwalletd {
    async fn connect(&self, endpoint: &str) -> Result<Client, Error> {
        let uri: http::Uri = endpoint.parse().map_err(|e| Error::Lightwalletd(format!("bad endpoint {endpoint}: {e}")))?;
        self.client
            .connect_to_lightwalletd(uri, self.allow_onion)
            .await
            .map_err(|e| Error::Lightwalletd(format!("tor connect {endpoint}: {e}")))
    }
}
