# CRDT Architecture & Federation Merge Rules

HelPhone uses an LWW-element-set for offline help state and cross-instance synchronization. Each operation carries an actor counter (vector-clock component), an instance domain namespace, and a wall-clock timestamp.

## 1. Single-Deployment Base Model
Within a single deployment, operations carry an actor ID, a monotonic counter, and a timestamp:
- Out-of-order replay converges deterministically.
- Causal-stability pruning purges superseded operations and tombstones once all active replicas' state vectors acknowledge them.
- Operations are exposed via `/api/sync` and cached locally in client storage.

## 2. Cross-Deployment Federation Model (ISP-144)
Across independent HelPhone deployments, there is no shared Postgres database, no common sequencer, and no central tiebreaker authority. To prevent ID collisions and state corruption:

### 2.1 Namespaced Operation Identifiers
Every operation is globally unique across the federation mesh:
$$\text{OpID} = \text{instance} : \text{actor} : \text{counter}$$
- `instance`: Originating deployment ID (e.g., `city-a`, `city-b`).
- `actor`: Local actor/client UUID.
- `counter`: Monotonically increasing sequence number per actor.

### 2.2 Deterministic Cross-Domain Merge Lattice
When concurrent operations are received from different administrative domains, HelPhone avoids blind wall-clock wins for life-critical incident attributes.

#### Status Lifecycle Lattice
Emergency state transitions must preserve human life during communications blackouts:
$$\text{critical} (55) > \text{escalated} (50) > \text{resolved} (40) > \text{in\_progress} (30) > \text{assigned} (20) > \text{open} (10) > \text{cancelled} (5)$$

**Rule 1 (Escalation over Resolution):** If Instance A marks an incident `resolved` while Instance B simultaneously marks it `escalated`, the safety lattice awards the win to `escalated`. The merge engine appends `winnerAnnotation: "lattice:status_escalated_over_resolved"` to ensure operators on both sides understand why the incident remained active.

#### Priority Lattice
Severity escalations take precedence over downgrades:
$$\text{critical} (40) > \text{high} (30) > \text{medium} (20) > \text{low} (10)$$

#### Deterministic Total Order Fallback
For non-lattice fields or identical lattice ranks:
1. Higher timestamp wins (`lww:timestamp`).
2. If timestamps tie, higher counter wins (`tiebreaker:counter`).
3. If counters tie, lexicographically higher `instance` ID wins (`tiebreaker:instance_<id>`).
4. If instances tie, lexicographically higher `actor` ID wins (`tiebreaker:actor_<id>`).

### 2.3 Convergence Guarantee
Because the merge rules form a join-semilattice and the tiebreaking fallback defines a strict total order over all operations:
- For any set of operations $\mathcal{O}$ exchanged across any number of peer instances in arbitrary order or batch sizes, the resulting state $\mathcal{S}$ is guaranteed to be byte-identical on all participating nodes:
  $$\forall \pi \in \text{Permutations}(\mathcal{O}), \quad \text{Fold}(\text{apply}, \mathcal{S}_0, \pi) = \mathcal{S}_{\text{converged}}$$

### 2.4 Provenance & UI Demarcation
Replicated operations originating from remote instances are marked with `provenance: "peer_asserted"`. Client applications render these incidents with peer provenance badges (`ProvenanceBadge.jsx`) to clearly demarcate foreign peer claims from locally validated DAO transactions.
