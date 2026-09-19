# Scientific Estimands

## E-01 Canonical starting value

Target population: the frozen Swedish/Alga free-order solitaire model with five fair dice and risk-neutral final score.

Estimand: F(0,0), computed by exhaustive finite-horizon dynamic programming. Report the binary64 midpoint with the conservative numerical enclosure. Do not call the displayed decimal an exact symbolic value.

## E-02 Optimal-play simulation quantities

Target population: complete games generated under the archived canonical policy and declared independent run seeds.

Estimands: mean final score, SD, empirical distribution/quantiles/tails, bonus frequency, Yatzy frequency, category summaries, and turn trajectories. Simulation uncertainty is separate from the numerical enclosure.

## E-03 Visit-weighted decision population

Target population: every decision visit in the separately declared value-aware optimal-policy decision experiment. Weight is one per observed visit.

For each visit, define the legal action set A and finite midpoint action values Q(a). Export best action a1, second-best action a2 under deterministic action ordering, V-star=Q(a1), margin=Q(a1)-Q(a2), best immediate-score value, best legal-reroll value when rerolls remain, keeper size, turn, dice, mask, capped upper subtotal, rerolls remaining, hashes, tie class, and certification status.

Reroll advantage is max reroll Q minus max immediate-score Q. It is undefined only at the no-reroll stage, which is excluded from that estimand rather than encoded null.

## E-04 Structural decision atlas

Target population: the deterministic state sample, all 252 unordered rolls, and each applicable reroll stage. It is not an optimal-visit population.

State selection, state weights, unordered-roll multiplicity weights, target layer population, and stage are exported. Weighted and unweighted results are separately named. Counts never merge with E-03.

## E-05 Tie semantics

- Exact algebraic tie: action expressions are identical by exact discrete construction or separately proven exact equality.
- Certified interval tie: two action point values are equal under a defined exact identity and both enclosures support that identity.
- Numerically unresolved overlap: action intervals overlap and ordering cannot be certified.
- Tolerance near tie: nonnegative midpoint margin is below a declared descriptive tolerance without proof of equality.

The classifier emits one mutually exclusive class plus interval/order evidence. Tolerance never implies exactness.

## E-06 Upper-point quantities

For reachable state (M,u), with u less than 63 and reachable (M,u+1):

delta_continuation = F(M,u+1) - F(M,u).

delta_grant = 1 + 50 I(u=62) + F(M,min(63,u+1)) - F(M,u).

The intervention grants one upper point, consumes no category, leaves M fixed, and pays the threshold bonus exactly when crossing. Both raw and aggregate datasets remain separately named.

## E-07 Category option cost

For a legal score action c at a declared rolled position:

option_cost(c) = V-star(position) - Q-score(c).

Report only for declared visit-weighted or structural populations and conditions. It is not an intrinsic context-free category value.

## E-08 Surprising positions

Target population and selection rule are explicit for each table. Every selected row includes full state/roll/stage, selection reason, best and alternative actions, both values, regret, tie/certification, hashes, population, sampling design, and weight when applicable. Regret equals best value minus named alternative value.

## E-09 Paired policy comparisons

Unit: game index. Potential die value is counter-based on experiment seed, game, turn, roll opportunity, and physical die slot. Each policy receives the same complete potential-die schedule; deterministic slot assignment resolves multiset keeper choices.

For difference D=score(optimal)-score(comparator), report n, mean, sample SD, SE, declared interval, median, P(D>0), P(D=0), P(D<0), and paired differences in bonus and Yatzy indicators. Policies are the exact coded baselines, not proxies for human play.

## E-10 Historical compatibility value

Target model: kth-2012-implementation-compatible-v1, identical to the canonical model except that Two Pairs receives the highest single-pair score when no second distinct pair exists, matching released ScoreCard.scorePair behavior.

Report its freshly computed midpoint, enclosure, hashes, deterministic policy rebuild, and difference from the canonical model. The experiment can show the behavior is sufficient to reproduce the rounded historical result and strongly support the explanation; it cannot prove intent or exclude all other historical differences.

## Descriptive-only quantities

Bonus/no-bonus and Yatzy/no-Yatzy conditional final-score differences and category/final-score correlations are associations, not causal effects. Hardware timings are single-run measurements, not general benchmarks.

