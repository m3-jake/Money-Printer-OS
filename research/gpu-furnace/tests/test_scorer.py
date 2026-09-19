from mpo_gpu_furnace.fixture import make_synthetic_fixture,pack_fixture
from mpo_gpu_furnace.reference import score_all,bootstrap_pass
from mpo_gpu_furnace.scorer import score_batch,derive_chunking
import random,torch

def test_reference_zero_rounds_is_safe(): assert bootstrap_pass([1.0]*12,0,random.Random(1)) == 0.0
def test_cpu_torch_matches_reference_deterministic_metrics():
 p=pack_fixture(make_synthetic_fixture(seed=7,variants=24,rows=300,bootstrap_rounds=1)); r=score_all(p,rounds=1,seed=1); g=score_batch(p,device='cpu',dtype='float64',bootstrap_rounds=1,seed=1,vram_mb=256)
 keys=['walkAvgPct','geometricMeanPct','compoundedMultiple','maxDrawdownPct','profitVelocityPctPerMin','consistencyPct','activityPct','inactivityPenalty','heldOutAvgPct','stressAvgPct','worstPct','robustScoreDeterministic']
 for a,b in zip(r,g.metrics):
  assert a['samples']==b['samples'] and a['heldOutN']==b['heldOutN']
  for k in keys: assert abs(a[k]-b[k]) < 1e-9
def test_repeatable_and_bounded_chunking():
 p=pack_fixture(make_synthetic_fixture(seed=5,variants=32,rows=300,bootstrap_rounds=2)); a=score_batch(p,device='cpu',dtype='float64',bootstrap_rounds=2,seed=9,vram_mb=128); b=score_batch(p,device='cpu',dtype='float64',bootstrap_rounds=2,seed=9,vram_mb=128); assert a.metrics==b.metrics
 c,rc,m=derive_chunking(3000,4097,torch.float64,4096,90); assert 1<=c<=4097 and 1<=rc<=90 and m['estimatedPeakMb']<=4096
