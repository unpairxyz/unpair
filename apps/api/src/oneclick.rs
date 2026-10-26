//! Thin 1Click client for the optional quote proxy and status lookups.
//! The TypeScript SDK is the full client; this does only what the server needs.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;

#[derive(Clone)]
pub struct OneClick {
    http: reqwest::Client,
    base: String,
    jwt: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppFee {
    pub recipient: String,
    pub fee: u32,
}

impl OneClick {
    pub fn new(base: String, jwt: Option<String>) -> Result<Self, ApiError> {
        // reqwest is built without a bundled TLS provider; make sure ring is installed
        // before the first client is created. Idempotent.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("unpair-api/0.1")
            .build()
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            http,
            jwt,
        })
    }

    pub fn has_key(&self) -> bool {
        self.jwt.is_some()
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.jwt {
            Some(j) => req.bearer_auth(j),
            None => req,
        }
    }

    /// Forward a quote request. `body` is the caller's request with appFees replaced.
    pub async fn quote(
        &self,
        mut body: Value,
        app_fees: Option<Vec<AppFee>>,
    ) -> Result<Value, ApiError> {
        let obj = body
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("quote body must be a JSON object".into()))?;
        // Never let a caller choose the fee. The server's fee config wins.
        obj.remove("appFees");
        if let Some(fees) = app_fees {
            obj.insert(
                "appFees".into(),
                serde_json::to_value(fees).expect("serialisable"),
            );
        }
        let req = self.auth(
            self.http
                .post(format!("{}/v0/quote", self.base))
                .json(&body),
        );
        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))?;
        let status = resp.status();
        let json: Value = resp
            .json()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))?;
        if !status.is_success() {
            let msg = json
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("quote rejected")
                .to_string();
            return Err(ApiError::BadRequest(format!(
                "The route did not accept this quote: {msg}"
            )));
        }
        Ok(json)
    }

    /// The route's token list, as `/v0/tokens` returns it.
    pub async fn tokens(&self) -> Result<Value, String> {
        let resp = self
            .auth(self.http.get(format!("{}/v0/tokens", self.base)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("tokens {}", resp.status()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !v.is_array() {
            return Err("tokens: not a list".into());
        }
        Ok(v)
    }

    /// Tell 1Click about a deposit transaction so it starts the swap at once.
    pub async fn submit_deposit(
        &self,
        tx_hash: &str,
        deposit_address: &str,
    ) -> Result<Value, ApiError> {
        let body = serde_json::json!({ "txHash": tx_hash, "depositAddress": deposit_address });
        let resp = self
            .auth(
                self.http
                    .post(format!("{}/v0/deposit/submit", self.base))
                    .json(&body),
            )
            .send()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ApiError::Upstream(format!(
                "deposit submit {}",
                resp.status()
            )));
        }
        resp.json()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))
    }

    pub async fn status(
        &self,
        deposit_address: &str,
        memo: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut req = self
            .http
            .get(format!("{}/v0/status", self.base))
            .query(&[("depositAddress", deposit_address)]);
        if let Some(m) = memo {
            req = req.query(&[("depositMemo", m)]);
        }
        let resp = self
            .auth(req)
            .send()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ApiError::NotFound);
        }
        if !resp.status().is_success() {
            return Err(ApiError::Upstream(format!("status {}", resp.status())));
        }
        resp.json()
            .await
            .map_err(|e| ApiError::Upstream(e.to_string()))
    }
}

/// Pull the addresses that must be screened out of a quote request body.
pub fn addresses_to_screen(body: &Value) -> Result<Vec<(String, String)>, ApiError> {
    let get = |k: &str| {
        body.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let refund =
        get("refundTo").ok_or_else(|| ApiError::BadRequest("refundTo is required".into()))?;
    let recipient =
        get("recipient").ok_or_else(|| ApiError::BadRequest("recipient is required".into()))?;
    let origin_chain = get("originAsset")
        .and_then(|a| chain_of_asset(&a))
        .unwrap_or_else(|| "unknown".into());
    let dest_chain = get("destinationAsset")
        .and_then(|a| chain_of_asset(&a))
        .unwrap_or_else(|| "unknown".into());
    Ok(vec![(refund, origin_chain), (recipient, dest_chain)])
}

/// `nep141:base-0x....omft.near` -> `base`; `nep141:zec.omft.near` -> `zec`; `nep141:wrap.near` -> `near`.
pub fn chain_of_asset(asset_id: &str) -> Option<String> {
    let rest = asset_id.strip_prefix("nep141:")?;
    if let Some(prefix) = rest.strip_suffix(".omft.near") {
        return Some(prefix.split('-').next().unwrap_or(prefix).to_string());
    }
    if rest.ends_with(".near") {
        return Some("near".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chain_ids() {
        assert_eq!(
            chain_of_asset("nep141:zec.omft.near").as_deref(),
            Some("zec")
        );
        assert_eq!(
            chain_of_asset("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")
                .as_deref(),
            Some("base")
        );
        assert_eq!(chain_of_asset("nep141:wrap.near").as_deref(), Some("near"));
        assert_eq!(chain_of_asset("nothing"), None);
    }

    #[test]
    fn screening_targets() {
        let body = json!({"refundTo": " 0xabc ", "recipient": "t1x", "originAsset": "nep141:eth.omft.near", "destinationAsset": "nep141:zec.omft.near"});
        assert_eq!(
            addresses_to_screen(&body).unwrap(),
            vec![
                ("0xabc".to_string(), "eth".to_string()),
                ("t1x".to_string(), "zec".to_string())
            ]
        );
        assert!(matches!(
            addresses_to_screen(&json!({"recipient": "x"})),
            Err(ApiError::BadRequest(_))
        ));
    }
}
