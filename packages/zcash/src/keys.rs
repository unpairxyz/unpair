//! Keys and addresses.
//!
//! One ZIP-32 account per user. Each swap gets the next unified address of
//! that account. The transparent receiver of that address is the landing
//! address the route operator pays. Its Orchard receiver is where the shield
//! step sends the funds; Ironwood, the live pool, shares the Orchard receiver. A landing address is used once.

use bip0039::{English, Mnemonic};
use secrecy::{ExposeSecret, SecretVec};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::encoding::encode_transparent_address_p;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::consensus::Parameters;
use zcash_transparent::address::TransparentAddress;
use zip32::{AccountId, DiversifierIndex};

use crate::error::Error;

/// A 64 byte BIP-39 seed. Zeroised on drop by `secrecy`.
pub struct Seed(SecretVec<u8>);

impl Seed {
    /// Seed from a BIP-39 phrase. Zcash wallets use an empty passphrase.
    pub fn from_phrase(phrase: &str) -> Result<Self, Error> {
        let m =
            Mnemonic::<English>::from_phrase(phrase).map_err(|e| Error::Mnemonic(e.to_string()))?;
        Ok(Seed(SecretVec::new(m.to_seed("").to_vec())))
    }

    /// A new 24 word phrase and its seed. Show the phrase to the user once.
    pub fn generate() -> (String, Self) {
        let m = Mnemonic::<English>::generate(bip0039::Count::Words24);
        let seed = Seed(SecretVec::new(m.to_seed("").to_vec()));
        (m.phrase().to_string(), seed)
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, Error> {
        if bytes.len() < 32 || bytes.len() > 252 {
            return Err(Error::Derivation("seed must be 32 to 252 bytes".into()));
        }
        Ok(Seed(SecretVec::new(bytes)))
    }

    pub fn expose(&self) -> &[u8] {
        self.0.expose_secret()
    }

    pub(crate) fn secret_vec(&self) -> SecretVec<u8> {
        SecretVec::new(self.0.expose_secret().clone())
    }
}

/// Derive the unified spending key for `account`.
pub fn spending_key<P: Parameters>(
    params: &P,
    seed: &Seed,
    account: u32,
) -> Result<UnifiedSpendingKey, Error> {
    let account = AccountId::try_from(account)
        .map_err(|_| Error::Derivation("account index out of range".into()))?;
    UnifiedSpendingKey::from_seed(params, seed.expose(), account)
        .map_err(|e| Error::Derivation(format!("{e:?}")))
}

/// A landing address and the shielded receiver it will be swept into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Landing {
    /// Diversifier index of the unified address this landing comes from.
    pub index: DiversifierIndex,
    /// Transparent receiver. This is what the route operator pays.
    pub transparent: TransparentAddress,
    /// The full unified address, with Orchard receiver (used by Ironwood too).
    pub unified: UnifiedAddress,
}

impl Landing {
    /// Base58Check t-address for the network, for example `t1...` on mainnet.
    pub fn transparent_string<P: Parameters>(&self, params: &P) -> String {
        encode_transparent_address_p(params, &self.transparent)
    }

    /// Bech32m unified address, `u1...` on mainnet.
    pub fn unified_string<P: Parameters>(&self, params: &P) -> String {
        self.unified.encode(params)
    }
}

/// The landing at diversifier index `j`, or the next valid index at or after `j`.
/// Requires that the address has both an Orchard and a transparent receiver.
pub fn landing_at(ufvk: &UnifiedFullViewingKey, j: DiversifierIndex) -> Result<Landing, Error> {
    let (ua, index) = ufvk
        .find_address(j, UnifiedAddressRequest::ALLOW_ALL)
        .map_err(|e| Error::Address(format!("{e:?}")))?;
    let transparent = *ua
        .transparent()
        .ok_or_else(|| Error::Address("unified address has no transparent receiver".into()))?;
    if !ua.has_orchard() {
        return Err(Error::Address(
            "unified address has no Orchard receiver".into(),
        ));
    }
    Ok(Landing {
        index,
        transparent,
        unified: ua,
    })
}

/// A unified address at diversifier index `j` with only an Orchard receiver.
/// A route that can pay Ironwood directly, such as 1Click, pays this and the
/// value lands shielded with no transparent step. It must have no transparent
/// receiver, or the route may pay that one instead.
pub fn orchard_only_at(
    ufvk: &UnifiedFullViewingKey,
    j: DiversifierIndex,
) -> Result<(UnifiedAddress, DiversifierIndex), Error> {
    let (ua, index) = ufvk
        .find_address(j, UnifiedAddressRequest::ORCHARD)
        .map_err(|e| Error::Address(format!("{e:?}")))?;
    if ua.transparent().is_some() || ua.sapling().is_some() || !ua.has_orchard() {
        return Err(Error::Address(
            "expected an Orchard-only unified address".into(),
        ));
    }
    Ok((ua, index))
}

/// Encode a transparent address for display.
pub fn encode_transparent<P: Parameters>(params: &P, addr: &TransparentAddress) -> String {
    encode_transparent_address_p(params, addr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::Network;

    // Public BIP-39 test vector. Never fund it.
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn phrase_to_seed_matches_bip39_vector() {
        let seed = Seed::from_phrase(PHRASE).unwrap();
        assert_eq!(
            hex::encode(&seed.expose()[..16]),
            "408b285c123836004f4b8842c89324c1"
        );
    }

    #[test]
    fn rejects_bad_phrase() {
        assert!(matches!(
            Seed::from_phrase("not a phrase").err(),
            Some(Error::Mnemonic(_))
        ));
    }

    #[test]
    fn landings_are_distinct_and_deterministic() {
        let seed = Seed::from_phrase(PHRASE).unwrap();
        let usk = spending_key(&Network::MainNetwork, &seed, 0).unwrap();
        let ufvk = usk.to_unified_full_viewing_key();
        let a = landing_at(&ufvk, DiversifierIndex::new()).unwrap();
        let mut j = a.index;
        j.increment().unwrap();
        let b = landing_at(&ufvk, j).unwrap();
        assert_ne!(a.transparent, b.transparent);
        assert_ne!(a.unified, b.unified);
        let a2 = landing_at(&ufvk, DiversifierIndex::new()).unwrap();
        assert_eq!(a, a2);
        let t = a.transparent_string(&Network::MainNetwork);
        assert!(t.starts_with("t1"), "{t}");
        let u = a.unified_string(&Network::MainNetwork);
        assert!(u.starts_with("u1"), "{u}");
        assert!(a
            .unified_string(&Network::TestNetwork)
            .starts_with("utest1"));
    }

    #[test]
    fn generate_gives_24_words() {
        let (phrase, seed) = Seed::generate();
        assert_eq!(phrase.split_whitespace().count(), 24);
        assert_eq!(seed.expose().len(), 64);
        let again = Seed::from_phrase(&phrase).unwrap();
        assert_eq!(again.expose(), seed.expose());
    }
}
