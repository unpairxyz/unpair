//! A Sapling prover for builds that never prove Sapling.
//!
//! Unpair spends Ironwood notes and pays transparent or Ironwood outputs, so
//! the transaction builder never asks for a Sapling proof. The builder still
//! needs a prover type. Native builds pass the real one from `zcash_proofs`,
//! which needs the 50 MB Sapling parameters on disk. The browser build passes
//! this type instead: it prepares circuits like the real prover (that step
//! needs no parameters) and refuses to create a proof.
//!
//! The refusal is a panic, because the prover trait has no error path. It is
//! reached only if a proposal contains a Sapling spend or output, and
//! `ShieldWallet` checks every proposal for that before it builds.

use sapling_crypto::circuit::{Output, OutputParameters, Spend, SpendParameters};
use sapling_crypto::prover::{OutputProver, SpendProver};

/// Prover that can prepare Sapling circuits but never proves them.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSapling;

impl SpendProver for NoSapling {
    type Proof = <SpendParameters as SpendProver>::Proof;

    fn prepare_circuit(
        proof_generation_key: sapling_crypto::ProofGenerationKey,
        diversifier: sapling_crypto::Diversifier,
        rseed: sapling_crypto::Rseed,
        value: sapling_crypto::value::NoteValue,
        alpha: jubjub::Fr,
        rcv: sapling_crypto::value::ValueCommitTrapdoor,
        anchor: bls12_381::Scalar,
        merkle_path: sapling_crypto::MerklePath,
    ) -> Option<Spend> {
        <SpendParameters as SpendProver>::prepare_circuit(
            proof_generation_key,
            diversifier,
            rseed,
            value,
            alpha,
            rcv,
            anchor,
            merkle_path,
        )
    }

    fn create_proof<R: rand_core::Rng>(&self, _circuit: Spend, _rng: &mut R) -> Self::Proof {
        unreachable!("this build spends Ironwood only and cannot prove a Sapling spend")
    }

    fn encode_proof(proof: Self::Proof) -> sapling_crypto::bundle::GrothProofBytes {
        <SpendParameters as SpendProver>::encode_proof(proof)
    }
}

impl OutputProver for NoSapling {
    type Proof = <OutputParameters as OutputProver>::Proof;

    fn prepare_circuit(
        esk: &sapling_crypto::keys::EphemeralSecretKey,
        payment_address: sapling_crypto::PaymentAddress,
        rcm: jubjub::Fr,
        value: sapling_crypto::value::NoteValue,
        rcv: sapling_crypto::value::ValueCommitTrapdoor,
    ) -> Output {
        <OutputParameters as OutputProver>::prepare_circuit(esk, payment_address, rcm, value, rcv)
    }

    fn create_proof<R: rand_core::Rng>(&self, _circuit: Output, _rng: &mut R) -> Self::Proof {
        unreachable!("this build spends Ironwood only and cannot prove a Sapling output")
    }

    fn encode_proof(proof: Self::Proof) -> sapling_crypto::bundle::GrothProofBytes {
        <OutputParameters as OutputProver>::encode_proof(proof)
    }
}
