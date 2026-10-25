//! Signed quotes.
//!
//! The server signs the quote it hands out with an Ed25519 key. The web app
//! pins the public key, so a clone site cannot show a forged "Unpair" quote
//! with its own fee recipient. The signature covers the canonical JSON of the
//! quote response from 1Click plus the server's fee settings.

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::Serialize;

#[derive(Clone)]
pub struct QuoteSigner {
    key: SigningKey,
}

#[derive(Serialize)]
struct Signed<'a, T: Serialize> {
    v: u8,
    fee_recipient: &'a str,
    fee_bps: u32,
    quote: &'a T,
}

impl QuoteSigner {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn random() -> Self {
        let mut seed = [0u8; 32];
        rand::fill(&mut seed);
        Self::from_seed(seed)
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.key.verifying_key().to_bytes())
    }

    /// Canonical bytes that are signed. Deterministic for the same inputs.
    pub fn message<T: Serialize>(fee_recipient: &str, fee_bps: u32, quote: &T) -> Vec<u8> {
        let value = serde_json::to_value(Signed {
            v: 1,
            fee_recipient,
            fee_bps,
            quote,
        })
        .expect("serialisable");
        canonical_json(&value)
    }

    /// Base64 signature over `message`.
    pub fn sign<T: Serialize>(&self, fee_recipient: &str, fee_bps: u32, quote: &T) -> String {
        let sig = self.key.sign(&Self::message(fee_recipient, fee_bps, quote));
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn verify<T: Serialize>(
        public_key_hex: &str,
        signature_b64: &str,
        fee_recipient: &str,
        fee_bps: u32,
        quote: &T,
    ) -> bool {
        let Ok(pk_bytes) = hex::decode(public_key_hex) else {
            return false;
        };
        let Ok(pk_arr): Result<[u8; 32], _> = pk_bytes.try_into() else {
            return false;
        };
        let Ok(pk) = VerifyingKey::from_bytes(&pk_arr) else {
            return false;
        };
        let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(signature_b64) else {
            return false;
        };
        let Ok(sig) = Signature::from_slice(&sig_bytes) else {
            return false;
        };
        pk.verify(&Self::message(fee_recipient, fee_bps, quote), &sig)
            .is_ok()
    }
}

/// JSON with object keys sorted, no whitespace. Numbers and strings as serde_json prints them.
pub fn canonical_json(v: &serde_json::Value) -> Vec<u8> {
    fn write(v: &serde_json::Value, out: &mut Vec<u8>) {
        match v {
            serde_json::Value::Object(map) => {
                out.push(b'{');
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.extend(serde_json::to_vec(k).expect("string"));
                    out.push(b':');
                    write(&map[*k], out);
                }
                out.push(b'}');
            }
            serde_json::Value::Array(items) => {
                out.push(b'[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    write(item, out);
                }
                out.push(b']');
            }
            other => out.extend(serde_json::to_vec(other).expect("scalar")),
        }
    }
    let mut out = Vec::new();
    write(v, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys() {
        let v = json!({"b": 1, "a": {"d": [1, {"z": 2, "y": 3}], "c": "x"}});
        assert_eq!(
            String::from_utf8(canonical_json(&v)).unwrap(),
            r#"{"a":{"c":"x","d":[1,{"y":3,"z":2}]},"b":1}"#
        );
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let s = QuoteSigner::from_seed([7u8; 32]);
        let quote = json!({"quote": {"amountOut": "123"}, "signature": "x"});
        let sig = s.sign("unpair.near", 50, &quote);
        assert!(QuoteSigner::verify(
            &s.public_key_hex(),
            &sig,
            "unpair.near",
            50,
            &quote
        ));
        // A clone that swaps the recipient or fee fails verification.
        assert!(!QuoteSigner::verify(
            &s.public_key_hex(),
            &sig,
            "clone.near",
            50,
            &quote
        ));
        assert!(!QuoteSigner::verify(
            &s.public_key_hex(),
            &sig,
            "unpair.near",
            51,
            &quote
        ));
        assert!(!QuoteSigner::verify(
            &s.public_key_hex(),
            &sig,
            "unpair.near",
            50,
            &json!({"quote": {"amountOut": "124"}})
        ));
        assert!(!QuoteSigner::verify("00", &sig, "unpair.near", 50, &quote));
    }

    #[test]
    fn seed_is_deterministic() {
        assert_eq!(
            QuoteSigner::from_seed([1u8; 32]).public_key_hex(),
            QuoteSigner::from_seed([1u8; 32]).public_key_hex()
        );
        assert_ne!(
            QuoteSigner::random().public_key_hex(),
            QuoteSigner::random().public_key_hex()
        );
    }
}

#[cfg(test)]
mod vector {
    use super::*;
    use serde_json::json;

    /// Fixed vector shared with the web app's tests. Run with --nocapture to print.
    #[test]
    fn print_cross_language_vector() {
        let s = QuoteSigner::from_seed([7u8; 32]);
        let quote = json!({"correlationId":"c1","timestamp":"2026-10-25T12:00:00.000Z","signature":"sig","quoteRequest":{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,"amount":"1000000000","appFees":[{"recipient":"unpair.near","fee":25},{"recipient":"x","fee":25}]},"quote":{"amountIn":"1000000000","amountOut":"83847628","timeEstimate":160,"amountInUsd":"999.545000000000"}});
        let msg = String::from_utf8(QuoteSigner::message("unpair.near", 50, &quote)).unwrap();
        println!("VECTOR_PUBKEY={}", s.public_key_hex());
        println!("VECTOR_SIG={}", s.sign("unpair.near", 50, &quote));
        println!("VECTOR_MSG={msg}");
    }
}
