#!/usr/bin/env python3
import argparse,json,time
from mpo_gpu_furnace.fixture import make_synthetic_fixture,pack_fixture
from mpo_gpu_furnace.reference import score_all
from mpo_gpu_furnace.scorer import score_batch,describe_environment

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--device',default='auto'); ap.add_argument('--dtype',default='float64'); ap.add_argument('--variants',type=int,default=4097); ap.add_argument('--rows',type=int,default=3000); ap.add_argument('--rounds',type=int,default=90); ap.add_argument('--vram-mb',type=int,default=4096); a=ap.parse_args()
 p=pack_fixture(make_synthetic_fixture(seed=19,variants=a.variants,rows=a.rows,bootstrap_rounds=a.rounds))
 cold=score_batch(p,device=a.device,dtype=a.dtype,bootstrap_rounds=a.rounds,seed=4,vram_mb=a.vram_mb)
 warm=score_batch(p,device=a.device,dtype=a.dtype,bootstrap_rounds=a.rounds,seed=4,vram_mb=a.vram_mb)
 print(json.dumps({'env':describe_environment(),'variants':p.n_variants,'rows':p.n_rows,'rounds':a.rounds,'dtype':a.dtype,'coldMs':cold.timing['wallMs'],'warmMs':warm.timing['wallMs'],'warmVariantsPerSec':p.n_variants/(warm.timing['wallMs']/1000),'peakMemoryMb':warm.peak_memory_mb,'repeatable':cold.metrics==warm.metrics,'chunkVariants':warm.chunk_variants,'roundsChunk':warm.rounds_chunk},indent=2,default=str))
if __name__=='__main__': main()
