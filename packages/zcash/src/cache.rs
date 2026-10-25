//! In-memory block cache for the sync loop.
//!
//! The sync loop downloads compact blocks into a cache, scans them, then deletes
//! them. Our wallet only needs recent blocks, so memory is enough. Nothing is
//! written to disk.

use std::ops::Range;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use zcash_client_backend::data_api::chain::{error, BlockCache, BlockSource};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_protocol::consensus::BlockHeight;

#[derive(Clone, Default)]
pub struct MemBlockCache {
    blocks: Arc<Mutex<Vec<CompactBlock>>>,
}

#[derive(Debug, thiserror::Error)]
#[error("block cache lock poisoned")]
pub struct CacheError;

impl MemBlockCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.blocks.lock().map(|b| b.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn height(b: &CompactBlock) -> BlockHeight {
        BlockHeight::from_u32(b.height as u32)
    }

    fn in_range(range: &Range<BlockHeight>, b: &CompactBlock) -> bool {
        range.contains(&Self::height(b))
    }
}

impl BlockSource for MemBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .map_err(|_| error::Error::BlockSource(CacheError))?
            .iter()
            .filter(|b| from_height.is_none_or(|h| Self::height(b) >= h))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for b in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(b)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks.lock().map_err(|_| CacheError)?;
        Ok(blocks
            .iter()
            .filter(|b| range.is_none_or(|r| Self::in_range(r.block_range(), b)))
            .map(|b| b.height)
            .max()
            .map(|h| BlockHeight::from_u32(h as u32)))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let blocks = self.blocks.lock().map_err(|_| CacheError)?;
        let mut out: Vec<CompactBlock> = blocks
            .iter()
            .filter(|b| Self::in_range(range.block_range(), b))
            .cloned()
            .collect();
        out.sort_by_key(|b| b.height);
        Ok(out)
    }

    async fn insert(&self, mut compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.blocks.lock().map_err(|_| CacheError)?;
        blocks.append(&mut compact_blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut blocks = self.blocks.lock().map_err(|_| CacheError)?;
        blocks.retain(|b| !Self::in_range(range.block_range(), b));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::data_api::scanning::ScanPriority;

    fn block(height: u64) -> CompactBlock {
        CompactBlock { height, ..Default::default() }
    }

    #[tokio::test]
    async fn insert_read_delete() {
        let cache = MemBlockCache::new();
        cache.insert(vec![block(12), block(10), block(11)]).await.unwrap();
        assert_eq!(cache.get_tip_height(None).unwrap(), Some(BlockHeight::from_u32(12)));
        let range = ScanRange::from_parts(BlockHeight::from_u32(10)..BlockHeight::from_u32(12), ScanPriority::Historic);
        let read = cache.read(&range).await.unwrap();
        assert_eq!(read.iter().map(|b| b.height).collect::<Vec<_>>(), vec![10, 11]);
        cache.truncate(BlockHeight::from_u32(10)).await.unwrap();
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get_tip_height(None).unwrap(), Some(BlockHeight::from_u32(10)));
    }
}
