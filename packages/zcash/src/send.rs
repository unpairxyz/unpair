//! Hop two: pay a transparent address from the Ironwood pool.
//!
//! The spend takes Ironwood notes only, never Sapling or the old Orchard pool,
//! and puts change back into Ironwood. The chain shows one transparent output
//! with its amount, two padded Ironwood actions and the value that left the
//! pool. It does not show which note was spent.
//!
//! Only `t1` and `t3` addresses are paid. A `tex1` address asks to be paid
//! from transparent funds only, which would need an extra linkable hop, so it
//! is refused.

use zcash_address::ZcashAddress;
use zcash_keys::address::Address;
use zcash_protocol::consensus::{BlockHeight, NetworkUpgrade, Parameters};
use zcash_transparent::address::TransparentAddress;

use crate::error::Error;

/// Blocks before a network upgrade in which no transaction is built. A
/// transaction commits to the branch of its target height, so one built just
/// before activation can never be mined after it.
pub const UPGRADE_GUARD_BLOCKS: u32 = 40;

/// Parse and check a payout address for `params`' network. Accepts P2PKH and
/// P2SH transparent addresses, refuses everything else with a plain reason.
pub fn check_payout_address<P: Parameters>(params: &P, s: &str) -> Result<ZcashAddress, Error> {
    let s = s.trim();
    let zaddr = ZcashAddress::try_from_encoded(s)
        .map_err(|e| Error::PayoutAddress(format!("not a Zcash address: {e}")))?;
    let addr: Address = zaddr
        .clone()
        .convert_if_network(params.network_type())
        .map_err(|e| Error::PayoutAddress(format!("wrong network: {e}")))?;
    match addr {
        Address::Transparent(TransparentAddress::PublicKeyHash(_))
        | Address::Transparent(TransparentAddress::ScriptHash(_)) => Ok(zaddr),
        Address::Tex(_) => Err(Error::PayoutAddress(
            "a TEX address must be paid from transparent funds, which Unpair never holds".into(),
        )),
        _ => Err(Error::PayoutAddress(
            "the route must give a transparent address, t1 or t3".into(),
        )),
    }
}

/// `Err(UpgradeWindow)` when `tip` is within [`UPGRADE_GUARD_BLOCKS`] of a
/// network upgrade that is not active yet.
pub fn upgrade_guard<P: Parameters>(params: &P, tip: BlockHeight) -> Result<(), Error> {
    for nu in [NetworkUpgrade::Nu7] {
        if let Some(activation) = params.activation_height(nu) {
            if tip < activation && u32::from(activation) - u32::from(tip) <= UPGRADE_GUARD_BLOCKS {
                return Err(Error::UpgradeWindow(u32::from(activation) - u32::from(tip)));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::Network;

    #[test]
    fn accepts_t1_and_t3_on_mainnet() {
        let n = Network::MainNetwork;
        assert!(check_payout_address(&n, "t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F").is_ok());
        assert!(check_payout_address(&n, " t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd ").is_ok());
    }

    #[test]
    fn refuses_other_kinds() {
        let n = Network::MainNetwork;
        let t = check_payout_address(&n, "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU");
        assert!(matches!(t, Err(Error::PayoutAddress(ref m)) if m.contains("network")));
        let u = check_payout_address(&n, "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf");
        assert!(matches!(u, Err(Error::PayoutAddress(_))));
        let junk = check_payout_address(&n, "hello");
        assert!(matches!(junk, Err(Error::PayoutAddress(_))));
    }

    #[test]
    fn guard_blocks_only_just_before_nu7() {
        let n = Network::MainNetwork;
        let nu7 = n.activation_height(NetworkUpgrade::Nu7).unwrap();
        assert!(upgrade_guard(&n, nu7 - 1000).is_ok());
        assert!(matches!(
            upgrade_guard(&n, nu7 - 40),
            Err(Error::UpgradeWindow(40))
        ));
        assert!(matches!(
            upgrade_guard(&n, nu7 - 1),
            Err(Error::UpgradeWindow(1))
        ));
        assert!(upgrade_guard(&n, nu7).is_ok());
        assert!(upgrade_guard(&n, nu7 + 5).is_ok());
    }
}
