# Exact Swedish Yatzy Solver
## Formal Rules, Mathematical Model, Architecture, and Verification Specification

**Document status:** Implementation-ready specification  
**Specification version:** 1.0.0  
**Target ruleset:** Swedish/Scandinavian Yatzy, Alga free-order variant  
**Ruleset identifier:** `swedish-alga-free-order-v1`  
**Primary objective:** Maximize expected final score  
**Canonical solver language:** Rust  
**Web runtime:** Rust compiled to WebAssembly, called from TypeScript  
**Date:** 2026-07-16

---

## 1. Purpose

This document specifies an exact decision engine for solitaire Swedish Yatzy.

Given a complete legal game position, the engine must determine the action that maximizes the expected final score under the assumptions that:

1. all five dice are fair;
2. dice rolls are mutually independent;
3. the selected ruleset is fixed for the whole game;
4. the player follows an optimal policy from the current position onward.

The application must accept the full information visible to a player:

- the five current dice;
- how many rerolls remain in the current turn;
- every scorecard category;
- which categories are unused;
- which categories have recorded scores;
- which categories have been crossed out;
- the current upper-section subtotal;
- whether the upper bonus has been earned;
- the current total score;
- the active ruleset.

It must return, in milliseconds after loading its precomputed data:

- whether to score now or reroll;
- which dice values to retain and reroll;
- which category to fill;
- whether that action records points or crosses out the category;
- the expected final score after each considered action;
- the expected-value loss of every ranked alternative;
- all mathematically tied optimal actions;
- enough structured data to explain and visualize the decision.

This project is an exact probabilistic optimization system, not a machine-learning model.

---

## 2. Normative language

The keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST** indicates a requirement for a conforming implementation.
- **SHOULD** indicates a strong recommendation that may be departed from only for a documented reason.
- **MAY** indicates an optional feature.

---

## 3. Scope

### 3.1 Included in version 1

Version 1 MUST implement:

- five six-sided dice;
- fifteen scorecard categories;
- free-order scoring;
- one initial roll and up to two rerolls per turn;
- scoring after the initial roll, first reroll, or second reroll;
- arbitrary retention of zero to four dice before a reroll;
- exact Alga-style Swedish scoring;
- a 50-point upper bonus at 63 or more upper-section points;
- no additional Yatzy bonuses;
- no Joker rule;
- an optimal solitaire policy maximizing expected final score;
- complete precomputation of turn-boundary values;
- local reconstruction of optimal actions at query time;
- deterministic artifact generation;
- correctness tests and simulation-based validation;
- a browser-compatible query engine.

### 3.2 Explicit non-goals for version 1

Version 1 does not include:

- multiplayer strategy;
- maximizing probability of beating a known opponent;
- risk-sensitive objectives such as maximizing a percentile or avoiding low scores;
- loaded or physically biased dice;
- forced-order Yatzy;
- upper-section-first order;
- Maxi Yatzy;
- Triple Yatzy;
- saved unused rerolls;
- American Yahtzee;
- Yahtzee bonuses or Joker rules;
- online learning;
- neural networks;
- approximate search in place of exact dynamic programming.

These MAY be introduced later as separate rulesets or objectives. They MUST NOT silently alter `swedish-alga-free-order-v1`.

---

## 4. Authoritative ruleset

### 4.1 Source basis

The normative game rules are based on Alga's Swedish “Yatzy on the road” instructions, using play option 3: **play in any order**.

The source rules state that a player:

- rolls all five dice initially;
- may make one or two rerolls with any chosen number of dice;
- records a score after the turn;
- may play all categories in any order under option 3;
- records zero in an available category when no points are scored;
- earns 50 bonus points for at least 63 upper-section points;
- uses fifteen standard Swedish Yatzy categories.

The project freezes all implementation-relevant interpretations below. A future disagreement about household rules must be handled by creating a different ruleset identifier rather than changing this one.

### 4.2 Turn sequence

A game contains exactly fifteen turns, one for each scoring category.

At the beginning of each turn:

1. all five dice are rolled;
2. the player has two rerolls remaining.

After any roll, including the initial roll, the player MAY:

- score the current dice in any unused category; or
- if at least one reroll remains, reroll one or more dice.

After the second reroll, no rerolls remain and the player MUST score in an unused category.

A turn ends immediately after a category is filled.

The player MUST NOT alter a category after it has been filled.

### 4.3 No-op rerolls

Holding all five dice while consuming a reroll cannot improve the state because scoring is already allowed. It is therefore a dominated no-op.

The solver MUST NOT expose a “reroll zero dice” action. Keeper actions MUST retain between zero and four dice.

This does not change the optimal value of the game.

### 4.4 Free-order play

Any unused category may be selected after any roll.

There is no obligation to complete the upper section before the lower section.

### 4.5 Zero scores and crossing out

Selecting a category for which the current dice produce no qualifying score records zero in that category.

Mathematically, crossing out is not a separate transition. It is a scoring action with immediate reward zero.

The user interface SHOULD present such an action as:

> Cross out `<category>`

rather than:

> Score 0 in `<category>`

The underlying API action type remains `score`.

### 4.6 Categories and bit assignments

The canonical category order and bit positions are fixed:

| Bit | Identifier | Display name | Section |
|---:|---|---|---|
| 0 | `ones` | Ones | Upper |
| 1 | `twos` | Twos | Upper |
| 2 | `threes` | Threes | Upper |
| 3 | `fours` | Fours | Upper |
| 4 | `fives` | Fives | Upper |
| 5 | `sixes` | Sixes | Upper |
| 6 | `one_pair` | One Pair | Lower |
| 7 | `two_pairs` | Two Pairs | Lower |
| 8 | `three_of_a_kind` | Three of a Kind | Lower |
| 9 | `four_of_a_kind` | Four of a Kind | Lower |
| 10 | `small_straight` | Small Straight | Lower |
| 11 | `large_straight` | Large Straight | Lower |
| 12 | `full_house` | Full House | Lower |
| 13 | `chance` | Chance | Lower |
| 14 | `yatzy` | Yatzy | Lower |

A set bit means that the category is already used.

The complete mask is:

```text
0b111_111_111_111_111 = 32767
```

### 4.7 Dice representation

Let a roll be represented by face counts:

\[
\mathbf{n}=(n_1,n_2,n_3,n_4,n_5,n_6),
\qquad
n_i\in\{0,\ldots,5\},
\qquad
\sum_{i=1}^{6}n_i=5.
\]

The order of physical dice is irrelevant.

The canonical external dice representation is a sorted array of five integers:

```json
[1, 2, 2, 5, 6]
```

The canonical internal representation SHOULD be six face counts:

```text
[1, 2, 0, 0, 1, 1]
```

There are exactly:

\[
\binom{6+5-1}{5}=\binom{10}{5}=252
\]

unordered five-dice outcomes.

### 4.8 Scoring principle for ambiguous decompositions

When a roll contains more than one valid way to instantiate a category, the category score is the **maximum valid score**.

For example, a roll containing pairs of fours and sixes scores 12 in One Pair because the pair of sixes is selected.

This definition corresponds to a rational player choosing the highest-scoring qualifying subset and removes ambiguity from the scoring function.

---

## 5. Exact scoring functions

Let `count(i)` be the number of dice showing face \(i\).

Every category scorer MUST be a pure deterministic function of the five dice.

### 5.1 Upper section

For face \(i\in\{1,\ldots,6\}\):

\[
s_{\text{upper},i}(\mathbf{n})=i\cdot n_i.
\]

Examples:

```text
[1, 1, 1, 4, 6] in Ones  -> 3
[2, 2, 2, 2, 5] in Twos  -> 8
[6, 6, 6, 6, 6] in Sixes -> 30
```

An upper category always has a legal numeric score, including zero.

### 5.2 One Pair

A valid pair is any face appearing at least twice.

\[
s_{\text{pair}}(\mathbf{n})
=
\max\left(\{2i:n_i\ge2\}\cup\{0\}\right).
\]

Examples:

```text
[2, 2, 4, 4, 6] -> 8
[5, 5, 5, 5, 6] -> 10
[1, 2, 3, 4, 5] -> 0
[6, 6, 6, 6, 6] -> 12
```

A triple, four of a kind, or Yatzy contains a qualifying pair for this category.

### 5.3 Two Pairs

Two Pairs requires two **different** face values, each appearing at least twice.

Let:

\[
P=\{i:n_i\ge2\}.
\]

Then:

\[
s_{\text{two-pairs}}(\mathbf{n})
=
\begin{cases}
2a+2b,& \text{where }a>b\text{ are the two largest values in }P,\\
0,& |P|<2.
\end{cases}
\]

Examples:

```text
[2, 2, 5, 5, 6] -> 14
[2, 2, 2, 5, 5] -> 14
[4, 4, 4, 4, 6] -> 0
[6, 6, 6, 6, 6] -> 0
```

Four equal dice do not constitute two different pairs.

### 5.4 Three of a Kind

\[
s_{\text{three-kind}}(\mathbf{n})
=
\max\left(\{3i:n_i\ge3\}\cup\{0\}\right).
\]

Examples:

```text
[4, 4, 4, 2, 6] -> 12
[5, 5, 5, 5, 1] -> 15
[6, 6, 6, 6, 6] -> 18
```

### 5.5 Four of a Kind

\[
s_{\text{four-kind}}(\mathbf{n})
=
\max\left(\{4i:n_i\ge4\}\cup\{0\}\right).
\]

Examples:

```text
[2, 2, 2, 2, 5] -> 8
[6, 6, 6, 6, 6] -> 24
[4, 4, 4, 2, 6] -> 0
```

### 5.6 Small Straight

Small Straight requires the exact multiset:

```text
[1, 2, 3, 4, 5]
```

Its score is 15.

\[
s_{\text{small-straight}}(\mathbf{n})
=
\begin{cases}
15,& \mathbf{n}=(1,1,1,1,1,0),\\
0,& \text{otherwise}.
\end{cases}
\]

### 5.7 Large Straight

Large Straight requires the exact multiset:

```text
[2, 3, 4, 5, 6]
```

Its score is 20.

\[
s_{\text{large-straight}}(\mathbf{n})
=
\begin{cases}
20,& \mathbf{n}=(0,1,1,1,1,1),\\
0,& \text{otherwise}.
\end{cases}
\]

### 5.8 Full House

A Full House requires exactly three dice of one face and exactly two dice of another, different face.

\[
s_{\text{full-house}}(\mathbf{n})
=
\begin{cases}
3a+2b,& n_a=3,\ n_b=2,\ a\ne b,\\
0,& \text{otherwise}.
\end{cases}
\]

Examples:

```text
[2, 2, 5, 5, 5] -> 19
[3, 3, 3, 6, 6] -> 21
[6, 6, 6, 6, 6] -> 0
[4, 4, 4, 4, 2] -> 0
```

A Yatzy is not a Full House because the pair and triple must have different values.

### 5.9 Chance

\[
s_{\text{chance}}(\mathbf{n})
=
\sum_{i=1}^{6}i\,n_i.
\]

Chance ranges from 5 to 30.

### 5.10 Yatzy

\[
s_{\text{yatzy}}(\mathbf{n})
=
\begin{cases}
50,& \exists i:n_i=5,\\
0,& \text{otherwise}.
\end{cases}
\]

There are no repeat-Yatzy bonuses and no Joker rule.

### 5.11 Maximum possible score

The maximum score under this frozen ruleset is 374:

- upper section: 105;
- upper bonus: 50;
- lower section: 219.

This maximum is descriptive only. The solver does not maximize the probability of attaining 374; it maximizes expected final score.

---

## 6. Bonus semantics

Let \(U_{\text{raw}}\) be the sum of recorded scores in Ones through Sixes.

The bonus is:

\[
B(U_{\text{raw}})
=
\begin{cases}
50,& U_{\text{raw}}\ge63,\\
0,& U_{\text{raw}}<63.
\end{cases}
\]

The solver stores only:

\[
u=\min(U_{\text{raw}},63).
\]

When scoring an upper category with immediate upper score \(q\):

\[
u'=\min(63,u+q).
\]

The bonus transition reward is:

\[
\beta(u,q)
=
\begin{cases}
50,& u<63\text{ and }u+q\ge63,\\
0,& \text{otherwise}.
\end{cases}
\]

The bonus is therefore added exactly once, at the first transition crossing the threshold.

This is mathematically equivalent to adding it at the end of the game.

---

## 7. Optimization objective

The policy MUST maximize the expected final score.

For action \(a\) in state \(x\):

\[
Q(x,a)=\sum_y P(y\mid x,a)\left[r(x,a,y)+V(y)\right].
\]

The optimal value is:

\[
V(x)=\max_{a\in A(x)}Q(x,a).
\]

The optimal action set is:

\[
A^*(x)=\arg\max_{a\in A(x)}Q(x,a).
\]

A conforming solver MUST preserve multiple tied actions in its query result.

The objective is risk-neutral expected value. It does not intentionally become more or less aggressive because the player's existing total is unusually high or low.

---

## 8. Sufficient-state proof and state reduction

### 8.1 Complete user-visible state

A complete scorecard contains a status and score for all fifteen categories.

This information is necessary for:

- input validation;
- displaying the current total;
- reconstructing the scorecard;
- explaining the user's past game.

It is not all necessary for selecting the optimal future action.

### 8.2 Sunk-score principle

Scores already recorded in lower-section categories cannot affect:

- future dice probabilities;
- which categories remain available;
- future scoring functions;
- the upper bonus.

Their values are sunk rewards. Only whether those categories remain available matters.

The same applies to the individual history and ordering of all previous turns.

### 8.3 Upper-section compression

The individual recorded values in Ones through Sixes affect future play only through:

1. which upper categories remain unused;
2. the current distance from the 63-point bonus threshold.

Therefore, the six individual upper scores may be compressed to the capped subtotal \(u\).

### 8.4 Minimal turn-boundary state

The minimal state before the initial roll of a turn is:

\[
X=(M,u),
\]

where:

- \(M\in[0,32767]\) is the used-category mask;
- \(u\in[0,63]\) is the capped upper subtotal.

### 8.5 Minimal rolled state

After a roll, the decision state is:

\[
Y=(M,u,D,r),
\]

where:

- \(D\) is one of 252 unordered five-dice states;
- \(r\in\{0,1,2\}\) is the number of rerolls remaining.

### 8.6 Markov property

For the frozen ruleset, the conditional distribution of all future rewards depends only on the minimal state, not on the path used to reach it.

Consequently, the problem is a finite-horizon Markov decision process and can be solved exactly by backward dynamic programming.

---

## 9. Reachable scorecard-state enumeration

### 9.1 Naive upper bound

There are:

\[
2^{15}=32768
\]

used-category masks and 64 capped upper totals.

A rectangular table would contain:

\[
32768\cdot64=2,097,152
\]

entries.

Many mask-total pairs are impossible.

### 9.2 Reachable upper totals

For an upper category with face value \(i\), a filled score may be:

\[
0,i,2i,3i,4i,5i.
\]

For each six-bit upper mask \(U\), define:

\[
R(U)=
\left\{
\min\left(63,\sum_{i\in U}k_i i\right)
:
k_i\in\{0,1,2,3,4,5\}
\right\}.
\]

Across all 64 upper masks:

\[
\sum_U |R(U)|=2794.
\]

The nine lower-category bits are independent of \(u\), producing \(2^9=512\) lower masks.

The exact number of reachable turn-boundary states is therefore:

\[
2794\cdot512=1,430,528.
\]

### 9.3 Dense deterministic index

Split \(M\) into:

```text
upper_mask = M & 0x003F
lower_mask = (M >> 6) & 0x01FF
```

For every upper mask, generate:

- `reachable_u[upper_mask]`: sorted unique capped totals;
- `rank_u[upper_mask][u]`: rank in that sorted list, or `INVALID`;
- `count_u[upper_mask]`;
- `base[upper_mask]`.

Define:

\[
\operatorname{index}(M,u)
=
\operatorname{base}[U]
+
L\cdot |R(U)|
+
\operatorname{rank}_U(u).
\]

`base[U]` is the cumulative number of states for all preceding upper masks:

\[
\operatorname{base}[U]
=
512\sum_{j=0}^{U-1}|R(j)|.
\]

The enumeration algorithm and ordering MUST be part of the ruleset implementation and covered by snapshot tests.

No large hash map is required for canonical table lookup.

---

## 10. Bellman equations

### 10.1 Turn-boundary value

Let:

\[
F(M,u)
\]

be the optimal expected number of **additional** points from immediately before the initial roll of the next turn.

Terminal condition:

\[
F(M_{\text{all}},u)=0.
\]

### 10.2 Rolled-state value

Let:

\[
G_r(M,u,D)
\]

be the optimal expected additional score after observing dice \(D\), with \(r\) rerolls remaining.

### 10.3 Scoring action

For unused category \(c\notin M\), let:

- \(s_c(D)\) be its immediate category score;
- \(q_c(D)=s_c(D)\) if \(c\) is upper, otherwise 0;
- \(u_c'=\min(63,u+q_c(D))\);
- \(M_c'=M\cup\{c\}\).

Then:

\[
Q_{\text{score}}(c)
=
s_c(D)
+
\beta(u,q_c(D))
+
F(M_c',u_c').
\]

The best immediate scoring value is:

\[
S(M,u,D)
=
\max_{c\notin M}Q_{\text{score}}(c).
\]

### 10.4 Keeper action

A keeper \(K\) is a sub-multiset of \(D\) containing zero to four dice.

If \(|K|=k\), the player rerolls \(5-k\) dice.

Let \(O\) range over unordered outcomes of the rerolled dice. Then:

\[
Q_{\text{keep},r}(K)
=
\sum_O P(O\mid K)\,
G_{r-1}(M,u,\operatorname{sort}(K\cup O)).
\]

### 10.5 Rolled-state recurrence

With no rerolls:

\[
G_0(M,u,D)=S(M,u,D).
\]

With rerolls available:

\[
G_r(M,u,D)
=
\max
\left(
S(M,u,D),
\max_{\substack{K\subseteq D\\0\le |K|\le4}}
Q_{\text{keep},r}(K)
\right),
\quad r\in\{1,2\}.
\]

### 10.6 Initial-roll expectation

Let \(P_5(D)\) be the probability of unordered five-dice outcome \(D\).

Then:

\[
F(M,u)
=
\sum_D P_5(D)\,G_2(M,u,D).
\]

These equations completely define the canonical value function.

---

## 11. Exact transition probabilities

### 11.1 Initial roll

For dice-count vector \(\mathbf{n}\):

\[
P_5(\mathbf{n})
=
\frac{5!}{n_1!n_2!\cdots n_6!}\cdot\frac{1}{6^5}.
\]

The integer multiplicity is:

\[
w_5(\mathbf{n})=\frac{5!}{n_1!\cdots n_6!}.
\]

The implementation SHOULD store integer multiplicities and divide once by \(6^5=7776\).

It MUST verify:

\[
\sum_D w_5(D)=7776.
\]

### 11.2 Reroll outcome

If \(m\) dice are rerolled and their unordered outcome has counts \(\mathbf{o}\), then:

\[
P_m(\mathbf{o})
=
\frac{m!}{o_1!\cdots o_6!}\cdot\frac{1}{6^m}.
\]

The implementation MUST verify for every \(m\in\{1,\ldots,5\}\):

\[
\sum_{\mathbf{o}:\sum o_i=m}
\frac{m!}{o_1!\cdots o_6!}
=
6^m.
\]

### 11.3 Integer-first probability handling

Transition-generation code MUST preserve exact integer multiplicities.

Floating-point division SHOULD occur only during the expected-value calculation.

This reduces avoidable numerical error and makes probability tables straightforward to test.

---

## 12. Keeper transform

### 12.1 Keeper universe

A keeper is an unordered multiset containing zero to five dice.

The total number of keeper multisets is:

\[
\sum_{k=0}^{5}\binom{6+k-1}{k}=462.
\]

Size-five keepers correspond exactly to the 252 complete roll states.

### 12.2 Dynamic keeper recurrence

Given a terminal value array `roll[D]` for all complete five-dice states, define:

\[
H(K)=
\begin{cases}
\operatorname{roll}(K),& |K|=5,\\[4pt]
\frac16\sum_{d=1}^{6}H(K\cup\{d\}),& |K|<5.
\end{cases}
\]

Compute \(H(K)\) in decreasing keeper size from 5 to 0.

Then \(H(K)\) is the expected terminal value obtained by retaining \(K\) and rolling all missing dice.

### 12.3 Recovering legal keeper choices

For a current five-dice roll \(D\), a legal reroll action is any \(K\) satisfying:

- \(K\) is a sub-multiset of \(D\);
- \(0\le|K|\le4\).

The best reroll value is:

\[
R(D)=\max_{K\subseteq D,\ |K|\le4}H(K).
\]

The implementation MUST precompute the list of legal keeper IDs for every complete dice state.

### 12.4 Duplicate physical dice

An action is represented by counts retained per face, not by physical die identity.

For example:

```json
{
  "dice": [2, 2, 2, 5, 6],
  "keep_counts": [0, 2, 0, 0, 0, 0]
}
```

means “keep two of the three twos.”

Any two physical twos are strategically identical.

---

## 13. Precomputation algorithm

### 13.1 Dependency order

Scoring a category increases the number of used categories by one.

Therefore \(F(M,u)\) depends only on states with one more used category.

The solver MUST process masks in descending population count:

```text
15 used categories
14 used categories
...
0 used categories
```

The terminal layer with all categories used is zero.

### 13.2 Per-state calculation

For each reachable \((M,u)\) with at least one unused category:

1. For every complete dice state \(D\), evaluate every unused scoring category.
2. Store:
   - `score_value[D]`: maximum scoring-action value;
   - optionally `score_action[D]`: best scoring action for diagnostics.
3. Set:
   - `roll0[D] = score_value[D]`.
4. Apply the keeper transform to `roll0`.
5. For every \(D\):
   - find the best legal keeper;
   - set `roll1[D] = max(score_value[D], reroll_value_from_roll0[D])`.
6. Apply the keeper transform to `roll1`.
7. For every \(D\):
   - find the best legal keeper;
   - set `roll2[D] = max(score_value[D], reroll_value_from_roll1[D])`.
8. Compute:
   \[
   F(M,u)=\frac{1}{7776}\sum_D w_5(D)\operatorname{roll2}[D].
   \]
9. Store only \(F(M,u)\) in the canonical production table.

### 13.3 Why the policy table is not required

A full policy table would store decisions for scorecard states, dice states, and reroll stages.

The canonical design instead stores only 1,430,528 turn-boundary values and reconstructs the local policy on demand.

At 64-bit precision, the raw value payload is:

\[
1,430,528\cdot8=11,444,224\text{ bytes}
\]

before headers and optional certification data.

This is several orders of magnitude smaller than storing every rolled-state action.

### 13.4 Parallel execution

All states in the same used-category layer depend only on the completed next layer and are independent of one another.

The solver MAY parallelize within a layer.

Parallel execution MUST preserve deterministic results by ensuring:

- each state's internal reduction order is fixed;
- workers write to disjoint output indices;
- no floating-point sum is combined in nondeterministic thread order;
- category and keeper tie-breaking order is fixed.

---

## 14. Query-time action reconstruction

### 14.1 Inputs

A query supplies:

- normalized used-category mask \(M\);
- capped upper subtotal \(u\);
- current dice state \(D_q\);
- rerolls remaining \(r\in\{0,1,2\}\);
- optional current recorded total for display.

### 14.2 Local reconstruction algorithm

For the supplied scorecard state:

1. Compute `score_value[D]` and all scoring alternatives for every one of 252 dice states using the precomputed \(F\) table.
2. Define `roll0[D] = score_value[D]`.
3. If \(r\ge1\):
   - run keeper transform on `roll0`;
   - construct `roll1[D]`.
4. If \(r=2\):
   - run keeper transform on `roll1`;
   - construct `roll2[D]`.
5. For the queried dice \(D_q\), enumerate:
   - every unused scoring action;
   - every legal keeper action if rerolls remain.
6. Rank all actions by expected additional score.
7. Return all actions tied for first under the numerical-certification policy.
8. Compute expected final totals by adding the already recorded score.

This bounds query work to small fixed arrays and avoids traversing the full game tree.

### 14.3 Returned values

For every action, the report MUST distinguish:

- `immediate_points`;
- `bonus_points_now`;
- `expected_future_points_after_action`;
- `expected_additional_points`;
- `expected_final_total`;
- `regret_vs_best`.

For a scoring action:

\[
\text{expected additional}
=
\text{immediate}
+
\text{bonus now}
+
F(M',u').
\]

For a reroll action:

\[
\text{expected additional}
=
H_r(K),
\]

where \(H_r\) is derived from the appropriate next-stage roll array.

### 14.4 Ranking stability

The API MUST return actions in this order:

1. descending certified expected value;
2. action type order: `score`, then `reroll`, only for exact ties;
3. canonical category bit order for scoring ties;
4. keeper ID order for reroll ties.

Presentation code MAY group ties visually but MUST NOT alter the values.

---

## 15. Numerical precision and “100% accurate”

### 15.1 Mathematical exactness

The Bellman recurrence is exact for the stated model.

A finite-precision implementation can still make an incorrect comparison when two actions differ by less than accumulated numerical error.

The project MUST distinguish:

- **exact algorithm**;
- **numerically certified implementation**.

### 15.2 Canonical numeric type

The production value table MUST use IEEE-754 binary64 (`f64`).

`f32` MUST NOT be used for canonical values.

### 15.3 Certification requirement

An action may be described publicly as **certified optimal** only when the implementation has established that its true value is not below another action's true value.

The project SHOULD implement one of the following:

#### Option A: Interval table

Store outward-rounded lower and upper bounds for every \(F(M,u)\).

Propagate intervals through weighted sums and maxima.

At query time, action \(a\) is uniquely certified when:

\[
\operatorname{lower}(a)
>
\max_{b\ne a}\operatorname{upper}(b).
\]

Overlapping best intervals represent either a true tie or an unresolved near-tie.

#### Option B: High-precision fallback

Use `f64` for the complete table.

When the gap between the best and second-best action is below a conservative threshold, recompute the relevant values using higher precision and a verified error bound.

#### Option C: Combined approach

Ship midpoint values and compact error bounds, then invoke high precision only for unresolved positions.

Option C is preferred.

### 15.4 User-visible decision status

The decision response MUST include one of:

- `unique_certified_optimum`;
- `multiple_certified_optima`;
- `numerically_indistinguishable`;
- `uncertified`.

The normal user interface SHOULD avoid technical clutter but MUST NOT claim unique certainty when the status is unresolved.

### 15.5 Tie semantics

A true tie is not an error.

When multiple actions have equal optimal expected value, all are correct.

The UI SHOULD say:

> These actions are equally optimal.

---

## 16. Rule configuration and identity

### 16.1 Canonical rules document

The repository MUST contain a machine-readable file such as:

```text
rules/swedish-alga-free-order-v1.json
```

Minimum structure:

```json
{
  "id": "swedish-alga-free-order-v1",
  "dice": {
    "count": 5,
    "faces": 6,
    "fair": true
  },
  "turn": {
    "initial_roll": true,
    "max_rerolls": 2,
    "may_score_early": true,
    "allow_zero_dice_reroll": false
  },
  "order": "free",
  "upper_bonus": {
    "threshold": 63,
    "points": 50
  },
  "yatzy_bonus": null,
  "joker_rule": false,
  "categories": [
    "ones",
    "twos",
    "threes",
    "fours",
    "fives",
    "sixes",
    "one_pair",
    "two_pairs",
    "three_of_a_kind",
    "four_of_a_kind",
    "small_straight",
    "large_straight",
    "full_house",
    "chance",
    "yatzy"
  ]
}
```

### 16.2 Ruleset hash

The canonical JSON MUST be serialized deterministically and hashed with SHA-256.

Generated value artifacts MUST embed or reference this hash.

The application MUST refuse to load a value table whose ruleset hash does not match the running scorer.

---

## 17. Binary artifact format

### 17.1 Files

The canonical generated artifact consists of:

```text
generated/
├── swedish-alga-free-order-v1.values.bin
└── swedish-alga-free-order-v1.manifest.json
```

An optional certification build may add:

```text
swedish-alga-free-order-v1.bounds.bin
```

### 17.2 Value payload

The value file contains 1,430,528 little-endian `f64` values in deterministic dense-index order.

### 17.3 Header

The binary header SHOULD include:

| Field | Type | Requirement |
|---|---|---|
| magic | 8 bytes | `YTZVAL01` |
| format version | `u16` | initially `1` |
| header length | `u16` | bytes |
| state count | `u32` | `1430528` |
| category count | `u8` | `15` |
| upper cap | `u8` | `63` |
| numeric type | `u8` | `1 = f64-le` |
| reserved | bytes | zero |
| ruleset SHA-256 | 32 bytes | required |
| payload SHA-256 | 32 bytes | required |

The exact byte layout MUST be documented in code and covered by golden-file tests.

### 17.4 Manifest

The JSON manifest MUST include:

- format version;
- ruleset identifier and hash;
- solver version;
- Git commit;
- dirty-working-tree flag;
- compiler and target;
- CPU architecture;
- thread count;
- build start and end timestamps;
- wall-clock duration;
- peak resident memory if available;
- state count;
- raw and compressed sizes;
- payload checksum;
- computed starting expected value;
- validation summary;
- simulation summary;
- numerical-certification method.

### 17.5 Compression

The distributable website MAY use Brotli or Zstandard compression.

The decompressed payload MUST match the canonical SHA-256 checksum.

Compression must not alter the canonical artifact identity.

---

## 18. Software architecture

### 18.1 Suggested workspace

```text
yatzy-solver/
├── Cargo.toml
├── crates/
│   ├── yatzy-rules/
│   ├── yatzy-dice/
│   ├── yatzy-state/
│   ├── yatzy-solver/
│   ├── yatzy-table/
│   ├── yatzy-query/
│   ├── yatzy-sim/
│   ├── yatzy-analysis/
│   ├── yatzy-wasm/
│   └── yatzy-cli/
├── rules/
│   └── swedish-alga-free-order-v1.json
├── generated/
├── research/
├── tests/
├── benchmarks/
├── web/
└── docs/
```

### 18.2 Crate responsibilities

#### `yatzy-rules`

- category identifiers;
- ruleset parsing;
- scoring functions;
- bonus logic;
- validation;
- ruleset hash.

#### `yatzy-dice`

- dice and keeper representations;
- enumeration of 252 rolls;
- enumeration of 462 keepers;
- multinomial multiplicities;
- legal sub-keeper lists;
- transition tables.

#### `yatzy-state`

- mask operations;
- reachable upper totals;
- dense state indexing;
- scorecard normalization;
- packed state types.

#### `yatzy-solver`

- backward dynamic programming;
- keeper transforms;
- parallel layer execution;
- checkpoints;
- canonical value generation.

#### `yatzy-table`

- binary serialization;
- memory mapping;
- checksum validation;
- manifest handling;
- version compatibility.

#### `yatzy-query`

- local policy reconstruction;
- action ranking;
- regret calculation;
- explanations;
- numerical status.

#### `yatzy-sim`

- random game simulation;
- deterministic seeded runs;
- policy execution;
- score distribution;
- category statistics.

#### `yatzy-analysis`

- research metrics;
- exports to CSV/JSON;
- heuristic comparison;
- rule-comparison framework.

#### `yatzy-wasm`

- browser-safe API;
- value-table loading;
- compact serialization;
- no filesystem assumptions.

#### `yatzy-cli`

- user-facing commands;
- progress;
- benchmarks;
- artifact inspection.

### 18.3 Shared scoring logic

Precomputation, simulation, CLI queries, tests, and the web application MUST call the same canonical scoring implementation.

Duplicated JavaScript scoring logic SHOULD NOT determine decisions.

The frontend MAY implement non-authoritative display helpers, but the Rust/WASM result is canonical.

---

## 19. Public data model

### 19.1 Scorecard entry

```ts
type ScorecardEntry =
  | { status: "unused" }
  | { status: "scored"; points: number }
  | { status: "crossed_out"; points: 0 };
```

### 19.2 Query request

```ts
interface YatzyQueryRequest {
  rulesetId: "swedish-alga-free-order-v1";
  dice: [number, number, number, number, number];
  rerollsRemaining: 0 | 1 | 2;
  scorecard: Record<CategoryId, ScorecardEntry>;
}
```

### 19.3 Normalized context

```ts
interface NormalizedContext {
  usedMask: number;
  upperSubtotalRaw: number;
  upperSubtotalCapped: number;
  bonusEarned: boolean;
  recordedCategoryTotal: number;
  recordedTotalIncludingBonus: number;
}
```

### 19.4 Action types

```ts
interface ScoreAction {
  type: "score";
  category: CategoryId;
  immediatePoints: number;
  bonusPointsNow: 0 | 50;
  presentation: "record_score" | "cross_out";
}

interface RerollAction {
  type: "reroll";
  keepCounts: [number, number, number, number, number, number];
  rerollCounts: [number, number, number, number, number, number];
}
```

### 19.5 Ranked action

```ts
interface RankedAction {
  action: ScoreAction | RerollAction;
  expectedAdditionalPoints: number;
  expectedFinalTotal: number;
  regretVsBest: number;
  rank: number;
  tiedForBest: boolean;
}
```

### 19.6 Decision report

```ts
interface DecisionReport {
  rulesetId: string;
  rulesetHash: string;
  normalized: NormalizedContext;
  diceCanonical: [number, number, number, number, number];
  rerollsRemaining: 0 | 1 | 2;
  optimalActions: RankedAction[];
  alternatives: RankedAction[];
  expectedAdditionalPoints: number;
  expectedFinalTotal: number;
  decisionStatus:
    | "unique_certified_optimum"
    | "multiple_certified_optima"
    | "numerically_indistinguishable"
    | "uncertified";
  explanationData: ExplanationData;
  tableMetadata: {
    solverVersion: string;
    payloadSha256: string;
  };
}
```

---

## 20. Input validation

The query layer MUST reject invalid inputs with structured errors.

### 20.1 Dice validation

- exactly five dice;
- every value is an integer from 1 through 6.

### 20.2 Reroll validation

- `rerollsRemaining` is 0, 1, or 2;
- a rolled position must contain five dice.

### 20.3 Scorecard validation

- exactly fifteen known category identifiers;
- every category has one valid status;
- crossed-out categories have zero points;
- upper scores are multiples of their face value;
- upper scores are between 0 and five times their face value;
- lower scores are valid category outcomes or zero;
- number of used categories is between 0 and 14 while querying a current turn;
- a completed scorecard cannot request a new action.

For lower categories, validation SHOULD check whether the entered value is attainable under the rules:

| Category | Positive attainable scores |
|---|---|
| One Pair | 2, 4, 6, 8, 10, 12 |
| Two Pairs | sums of two distinct pairs |
| Three of a Kind | 3, 6, 9, 12, 15, 18 |
| Four of a Kind | 4, 8, 12, 16, 20, 24 |
| Small Straight | 15 |
| Large Straight | 20 |
| Full House | valid \(3a+2b\), \(a\ne b\) |
| Chance | 5 through 30 |
| Yatzy | 50 |

A positive value being arithmetically attainable does not prove it occurred historically, but is sufficient for scorecard validation.

### 20.4 Bonus consistency

The bonus is inferred from upper scores.

The client MUST NOT be allowed to independently declare an inconsistent bonus state.

### 20.5 Current-turn consistency

The count of used categories indicates how many completed turns exist.

The solver does not need the historical roll count.

---

## 21. Command-line interface

The CLI SHOULD expose:

```text
yatzy generate
yatzy verify
yatzy query
yatzy simulate
yatzy benchmark
yatzy inspect
yatzy export-analysis
```

### 21.1 Generate

Example:

```bash
yatzy generate \
  --rules rules/swedish-alga-free-order-v1.json \
  --output generated/ \
  --threads 16 \
  --checkpoint-every-layer
```

Required behavior:

- validate ruleset;
- enumerate and verify combinatorial tables;
- solve all layers;
- write checkpoints atomically;
- calculate checksums;
- produce manifest;
- never publish a partial artifact as complete.

### 21.2 Verify

```bash
yatzy verify \
  --artifact generated/swedish-alga-free-order-v1.values.bin \
  --full
```

### 21.3 Query

```bash
yatzy query --position position.json --top 20
```

### 21.4 Simulate

```bash
yatzy simulate \
  --games 1000000 \
  --seed 20260716 \
  --policy optimal \
  --output research/simulation-1m.json
```

### 21.5 Benchmark

The benchmark command SHOULD separately report:

- dice-table generation;
- state enumeration;
- scoring-action evaluation;
- keeper transforms;
- per-layer solve time;
- serialization;
- table load;
- query latency;
- simulation throughput.

---

## 22. Checkpointing and recovery

Full precomputation may run for a meaningful amount of time.

The solver SHOULD write one checkpoint after each completed used-category layer.

A checkpoint MUST contain:

- ruleset hash;
- solver version;
- completed layer;
- table prefix or completed indices;
- checksum;
- thread-independent metadata.

Checkpoint files MUST be written to a temporary file and atomically renamed after checksum completion.

The generator MUST refuse to resume from a mismatched ruleset or solver format.

---

## 23. Verification plan

No single test is sufficient. The project MUST use independent layers of verification.

### 23.1 Scoring tests

All 252 dice states MUST be evaluated in all 15 categories:

\[
252\cdot15=3780
\]

canonical scoring cases.

The test suite SHOULD compare the production scorer with a separately structured reference scorer.

Required fixtures include:

- every Yatzy face;
- every Full House;
- all pair and two-pair boundary cases;
- triples and four-of-a-kind reused in smaller-kind categories;
- Yatzy rejected as Full House and Two Pairs;
- both straights;
- all-zero category outcomes.

### 23.2 Dice enumeration tests

Verify:

- exactly 252 complete dice states;
- exactly 462 keeper states;
- no duplicates;
- canonical sorting;
- all count vectors sum to the required size.

### 23.3 Probability tests

For every reroll count:

- multiplicities are positive integers;
- denominator is \(6^m\);
- total multiplicity equals \(6^m\);
- mapped final rolls are valid.

For the initial roll:

\[
\sum_D w_5(D)=7776.
\]

### 23.4 Keeper-subset tests

For every complete dice state:

- every listed keeper is a valid sub-multiset;
- no valid sub-multiset is missing;
- no keeper of size five is exposed as a reroll action;
- duplicate physical selections collapse to one keeper action.

### 23.5 State-index tests

Verify:

- 64 upper masks;
- total reachable upper-state count 2794;
- total full state count 1,430,528;
- every generated state round-trips through `index` and `decode`;
- unreachable mask-total combinations are rejected;
- all indices from 0 through 1,430,527 are used exactly once.

### 23.6 Bellman invariants

For sampled and, where inexpensive, exhaustive states:

- terminal value is zero;
- all values are finite;
- all values are nonnegative;
- every recommended scoring category is unused;
- every recommended keeper is legal;
- a state with more rerolls has value at least as high as the same rolled state with fewer rerolls;
- `G_r` is at least the best immediate scoring value;
- bonus is awarded at most once;
- no transition decreases the number of used categories after scoring;
- no reroll transition changes the scorecard state.

### 23.7 Independent late-game solver

Implement a deliberately simple reference solver for positions with a small number of unused categories.

The reference solver MAY enumerate ordered dice outcomes and use memoization without the optimized keeper transform.

The optimized solver MUST match the reference solver within certified numerical bounds for all states in the selected reduced scope.

Recommended minimum:

- exhaustive comparison for every state with one or two unused categories;
- broad randomized comparison with three to five unused categories.

### 23.8 Determinism tests

Two runs with the same:

- ruleset;
- source commit;
- compiler mode;
- target architecture;
- numeric mode;

MUST produce identical payload checksums.

Runs with different thread counts SHOULD produce identical payload checksums.

### 23.9 Simulation validation

Simulate complete games using the generated optimal policy.

For \(N\) games, report:

- sample mean;
- sample standard deviation;
- standard error;
- 95% confidence interval;
- minimum and maximum;
- quantiles;
- bonus frequency;
- Yatzy frequency;
- category means.

The computed starting value SHOULD fall within the simulation confidence interval.

A stronger automated criterion is:

\[
|\bar{x}-F(0,0)|\le 3\frac{s}{\sqrt{N}}+\epsilon_{\text{numeric}}.
\]

### 23.10 External benchmark

A 2012 KTH report for Scandinavian Yatzy reported:

- optimal expected score: 248.63;
- 20,000-game simulated mean: 248.92;
- approximately 50 minutes of computation on an Intel Core i5-2500K;
- a 1.5 GB explicit strategy table.

The new solver SHOULD independently reproduce an expected starting score near 248.63.

This is a verification target, not a value to hard-code.

A meaningful discrepancy MUST trigger an investigation of:

- early-scoring interpretation;
- pair scoring;
- Full House treatment;
- bonus timing;
- keeper actions;
- probability multiplicities;
- numerical precision;
- source ruleset differences.

The artifact MUST record the independently calculated value even if it differs.

### 23.11 Mutation testing

The test suite SHOULD demonstrate that it detects intentional faults such as:

- allowing a Yatzy as Full House;
- treating four equal dice as Two Pairs;
- using 35 rather than 50 bonus points;
- scoring all five dice in Three of a Kind;
- accepting any four-dice sequence as Small Straight;
- omitting multinomial weights;
- awarding the bonus twice.

---

## 24. Performance requirements

Performance requirements are engineering targets, not mathematical requirements.

### 24.1 Precomputation

Baseline target on a modern multi-core desktop:

- wall-clock time: under 3 hours;
- preferred target: under 30 minutes;
- peak memory: under 8 GB;
- no unbounded task queue;
- resumable after a completed layer.

### 24.2 Artifact size

Required:

- midpoint `f64` payload near 11.45 MB;
- complete uncompressed value artifact under 15 MB, excluding optional bounds;
- value plus certification bounds SHOULD remain under 40 MB uncompressed;
- compressed web delivery SHOULD be minimized and measured.

### 24.3 Query latency

After table load:

- desktop p95: under 10 ms;
- typical mobile p95: under 30 ms;
- no network request per decision;
- no server dependency for core recommendations.

Latency benchmarks MUST state hardware, browser/runtime, and whether the table was already loaded.

### 24.4 Table loading

The web application SHOULD:

- load the compressed artifact once;
- verify checksum before use;
- cache it using standard browser caching;
- show deterministic progress;
- prevent queries until validation succeeds.

---

## 25. Explanation system

The explanation layer MUST derive statements from computed data.

It MUST NOT generate unsupported strategic prose such as “this is safer” without a defined metric.

### 25.1 Explanation data

For a reroll recommendation, compute where feasible:

- retained values;
- rerolled values;
- expected value;
- next-best keeper;
- regret gap;
- probability distribution over resulting complete rolls;
- probability of scoring positively in each unused category on the next roll;
- contribution of bonus proximity;
- whether scoring now is competitive.

For a scoring recommendation:

- immediate category score;
- bonus triggered now;
- continuation value after consuming the category;
- best alternative category;
- best reroll alternative if available;
- sacrifice cost of crossing out;
- long-term value of preserving other categories.

### 25.2 Avoiding false causal claims

A computed difference between two actions does not automatically prove a simple verbal cause.

The UI SHOULD use cautious, data-linked explanations:

> Keeping the three fours has an expected value 0.47 points higher than keeping the three fours and the six.

It MAY add a category-based explanation only when the displayed probabilities or continuation values support it.

### 25.3 Regret

For action \(a\):

\[
\operatorname{regret}(a)=V^*-Q(a).
\]

Regret is zero for every optimal action.

In “play against perfection” mode, cumulative decision regret is:

\[
R_{\text{game}}=\sum_t \operatorname{regret}(a_t).
\]

This measures decision quality independently of random dice outcomes.

---

## 26. Web application requirements

### 26.1 Main solver

The main interface SHOULD include:

- five interactive dice;
- rerolls-remaining selector;
- complete scorecard;
- score and crossed-out states;
- recommended action;
- ranked alternatives;
- expected final total;
- certainty/tie status;
- a compact explanation;
- an expandable technical view.

### 26.2 Input ergonomics

The user SHOULD be able to:

- click dice to change values;
- click dice to preview held/rerolled groups;
- enter scores directly;
- mark a category crossed out;
- reset a turn;
- load an example;
- share a position through a compact URL encoding.

### 26.3 Research view

An advanced view SHOULD expose:

- normalized mask and capped subtotal;
- canonical dice ID;
- Bellman components;
- immediate reward;
- bonus reward;
- continuation value;
- action gaps;
- ruleset hash;
- table checksum;
- solver version.

### 26.4 Accessibility

The interface MUST NOT rely only on die pip images or color.

Each die MUST have an accessible numeric label.

Action recommendations MUST be available as text.

Keyboard operation and visible focus states SHOULD be supported.

---

## 27. Research and analysis outputs

The solver SHOULD generate reproducible datasets for the case study.

### 27.1 Core outputs

- optimal starting expected score;
- score distribution under optimal play;
- upper-bonus frequency;
- category score means;
- category zero frequencies;
- Yatzy frequency;
- turn-by-turn expected remaining value;
- computation time by layer;
- memory use;
- artifact size;
- query latency distribution.

### 27.2 Heuristic comparisons

Candidate policies:

- maximize immediate category score;
- always pursue the upper bonus;
- fixed category priority;
- one-turn expected-value optimization;
- common human rules of thumb;
- random legal action.

For each policy, report:

- average score;
- loss relative to optimal;
- score variance;
- bonus frequency;
- category profile;
- decision regret against the exact solver.

### 27.3 Strategic-complexity measures

For future ruleset comparisons, define:

#### Decision margin

\[
\Delta(x)=Q(x,a_1)-Q(x,a_2),
\]

where \(a_1\) and \(a_2\) are the best and second-best actions.

Small margins indicate fragile or difficult decisions.

#### Greedy regret

Expected loss from selecting the action with the largest immediate score.

#### Lookahead value

Difference between full-game optimization and a one-turn optimizer.

#### Policy disagreement

Fraction of matched states for which two rulesets or policies select different optimal actions.

#### Policy entropy

A distributional measure of action diversity across weighted reachable states.

#### Bonus dependence

Expected-value change when the upper-bonus mechanism is removed or altered in a separate experimental ruleset.

All comparison metrics MUST state how states are sampled or weighted.

---

## 28. Reproducibility requirements

A published result MUST be reproducible from the repository.

The repository SHOULD include:

- locked Rust dependencies;
- exact rules JSON;
- build instructions;
- hardware and compiler metadata;
- deterministic seed files;
- artifact checksums;
- raw benchmark output;
- simulation result files;
- analysis scripts;
- chart-generation scripts;
- a one-command reproduction path where practical.

Suggested commands:

```bash
cargo test --workspace
cargo run --release --bin yatzy -- generate --rules rules/swedish-alga-free-order-v1.json
cargo run --release --bin yatzy -- verify --full
cargo run --release --bin yatzy -- simulate --games 1000000 --seed 20260716
cargo run --release --bin yatzy -- export-analysis
```

Generated charts MUST be reproducible from committed data or from clearly documented generated artifacts.

---

## 29. Security and robustness

Although the solver is not a high-risk service, the application MUST treat artifacts and user input as untrusted.

- validate binary lengths before allocation;
- reject unsupported format versions;
- verify checksums;
- reject invalid state indices;
- avoid panics on malformed web input;
- place upper limits on decompression output;
- do not execute data from manifests;
- use atomic artifact writes;
- fuzz parsers and scorecard normalization;
- avoid loading a table whose ruleset hash differs from the scorer.

The browser application SHOULD remain fully functional without sending game positions to a server.

---

## 30. Development milestones and acceptance criteria

### Milestone 0 — Specification freeze

Deliverables:

- this document;
- canonical rules JSON;
- category IDs and bit order;
- scoring examples;
- decision on numerical-certification strategy.

Acceptance:

- no unresolved rule ambiguity affecting values;
- ruleset hash generation implemented;
- versioning policy agreed.

### Milestone 1 — Rules and dice core

Deliverables:

- Rust workspace;
- category scorer;
- dice enumeration;
- keeper enumeration;
- probability multiplicities;
- state types.

Acceptance:

- 252 roll states;
- 462 keeper states;
- scoring fixtures pass;
- probability sums pass;
- no duplicate canonical states.

### Milestone 2 — Reachable-state index

Deliverables:

- upper-total reachability generator;
- dense index;
- encode/decode tests.

Acceptance:

- 2794 upper mask-total combinations;
- 1,430,528 complete states;
- exhaustive round-trip success.

### Milestone 3 — Reference solver

Deliverables:

- simple late-game solver;
- exhaustive one- and two-category results;
- golden fixtures.

Acceptance:

- independently understandable implementation;
- deterministic outputs;
- optimized code not reused in the central reference recurrence.

### Milestone 4 — Optimized full solver

Deliverables:

- layer-based dynamic program;
- keeper transform;
- parallel execution;
- checkpoints;
- progress reporting.

Acceptance:

- complete table generated;
- no invalid values;
- deterministic checksum across repeated runs;
- baseline time and memory measured.

### Milestone 5 — Verification and certification

Deliverables:

- full verification command;
- simulation engine;
- numerical tie/certification handling;
- external benchmark comparison.

Acceptance:

- all mandatory tests pass;
- simulation agrees with the computed starting value;
- difference from the 248.63 external reference is explained or within the chosen tolerance;
- decision status is never overstated.

### Milestone 6 — Query engine and WASM

Deliverables:

- local action reconstruction;
- ranked alternatives;
- structured explanations;
- WebAssembly bindings;
- table loader.

Acceptance:

- query matches precomputation/reference fixtures;
- p95 latency target measured;
- malformed input handled safely;
- no server needed for a recommendation.

### Milestone 7 — Interactive website

Deliverables:

- solver UI;
- scorecard input;
- dice controls;
- alternative action table;
- research view;
- shareable positions.

Acceptance:

- keyboard-accessible core flow;
- mobile and desktop layouts;
- ruleset and artifact provenance visible;
- crossed-out actions clearly presented.

### Milestone 8 — Research analysis and case study

Deliverables:

- benchmark report;
- simulation report;
- heuristic comparisons;
- visualizations;
- research-paper-style methodology;
- portfolio case study.

Acceptance:

- every headline number links to reproducible data;
- limitations are explicit;
- prior work is credited;
- claims distinguish exact mathematics from implementation verification.

---

## 31. Definition of done for version 1

Version 1 is complete when all of the following are true:

1. `swedish-alga-free-order-v1` is fixed and machine-readable.
2. Every scoring category has exhaustive tests over all 252 dice states.
3. Reachable scorecard states are enumerated deterministically.
4. The full \(F(M,u)\) table has been generated.
5. The table passes checksum and structural validation.
6. The computed starting value has been independently verified.
7. Complete-game simulations statistically agree with that value.
8. Near-ties are handled through a documented certification method.
9. The browser returns optimal actions without a server request.
10. Query latency meets the documented target on test hardware.
11. Every output identifies the ruleset and artifact version.
12. The repository can reproduce the published results.
13. The case study does not claim novelty for the existence of an optimal Scandinavian Yatzy strategy.
14. The case study clearly identifies the project's own contributions, such as compact storage, independent verification, web reconstruction, explainability, and comparative analysis.

---

## 32. Future extensions

Future work MAY add:

- American Yahtzee as a separate rules module;
- forced-order Swedish Yatzy;
- upper-section-first Yatzy;
- Maxi Yatzy;
- risk-sensitive policies;
- loaded-dice models;
- multiplayer win-probability optimization;
- score-distribution objectives;
- strategy compression experiments;
- serverless generation of custom rulesets;
- cross-ruleset difficulty analysis.

Every extension MUST define:

- its own ruleset identifier;
- scoring functions;
- state sufficiency;
- objective;
- transition model;
- artifact hash;
- validation benchmark.

A new ruleset MUST NOT reuse the old artifact unless the ruleset hash is identical.

---

## 33. Case-study positioning

The project SHOULD be presented as an independent, reproducible engineering and mathematical investigation.

A defensible summary is:

> An exact Swedish Yatzy decision engine built with finite-horizon dynamic programming. The solver compresses a complete scorecard to a sufficient state, precomputes approximately 1.43 million turn-boundary values, reconstructs optimal rolled-state actions locally in milliseconds, validates its policy through independent implementations and simulation, and exposes the result through an interactive research interface.

The strongest original contributions are expected to be:

- a modern independent reproduction;
- a compact values-only artifact;
- millisecond policy reconstruction;
- rigorous numerical tie handling;
- transparent expected-value explanations;
- reproducible performance measurements;
- quantified comparisons with human heuristics;
- a modular foundation for comparing Yatzy and Yahtzee rules.

---

## 34. References

1. **Alga. _Yatzy on the road_ rules.** Swedish instructions, including free-order play option, category rules, 63-point threshold, and 50-point bonus.  
   https://algaspel.se/wp-content/uploads/2023/10/yatzyrese.pdf  
   Accessed 2026-07-16.

2. **Marcus Larsson and Andreas Sjöberg. _Optimal Yatzy Strategy_. KTH Royal Institute of Technology, 2012.** Reports an optimal expected Scandinavian Yatzy score of 248.63 and describes a backward dynamic-programming implementation and keeper optimization.  
   https://www.csc.kth.se/utbildning/kth/kurser/DD143X/dkand12/Group89Michael/report/Larsson%2BSjoberg.pdf  
   Accessed 2026-07-16.

---

## Appendix A — Canonical examples

### A.1 Score now

Input:

```json
{
  "dice": [2, 2, 5, 5, 5],
  "rerollsRemaining": 1,
  "scorecard": {
    "full_house": { "status": "unused" }
  }
}
```

Candidate immediate scores include:

```text
Full House      19
Three of a Kind 15
Two Pairs       14
One Pair        10
Fives           15
Twos             4
Chance          19
```

The optimal action is not determined by immediate points alone. Each category has a different continuation value because consuming it changes future options.

### A.2 Cross out

Input dice:

```text
[1, 1, 2, 3, 4]
```

If the recommended unused category is Yatzy, its immediate score is zero.

API action:

```json
{
  "type": "score",
  "category": "yatzy",
  "immediatePoints": 0,
  "presentation": "cross_out"
}
```

### A.3 Reroll duplicate values

Input dice:

```text
[4, 4, 4, 4, 6]
```

A keeper retaining three fours is represented by face counts:

```json
[0, 0, 0, 3, 0, 0]
```

It does not matter which physical three of the four identical dice are retained.

### A.4 Bonus transition

Current capped upper subtotal:

```text
u = 60
```

Scoring one three in Threes gives:

```text
immediate category points = 3
bonus points now          = 50
new capped subtotal       = 63
```

### A.5 Sunk lower scores

These two histories are strategically equivalent if their remaining categories, upper subtotal, dice, and rerolls are identical:

```text
History A: Full House previously scored 28
History B: Full House previously scored  0
```

They have different current totals but the same optimal future action.

---

## Appendix B — Core pseudocode

```text
function solve_all_states():
    initialize F[all_used_mask, reachable_u] = 0

    for used_count from 14 down to 0:
        parallel for each reachable state (M, u)
            where popcount(M) == used_count:

            for each complete dice state D:
                score_value[D] = -infinity

                for each category c not in M:
                    immediate = score(D, c)
                    upper_gain = immediate if c is upper else 0
                    next_u = min(63, u + upper_gain)
                    bonus = 50 if u < 63 and next_u == 63 else 0
                    next_M = M with c set

                    candidate =
                        immediate
                        + bonus
                        + F[index(next_M, next_u)]

                    score_value[D] = max(score_value[D], candidate)

            roll0 = score_value

            keep0 = keeper_transform(roll0)
            for each complete dice state D:
                reroll0 = max keep0[K]
                    for legal K proper-submultiset of D
                roll1[D] = max(score_value[D], reroll0)

            keep1 = keeper_transform(roll1)
            for each complete dice state D:
                reroll1 = max keep1[K]
                    for legal K proper-submultiset of D
                roll2[D] = max(score_value[D], reroll1)

            total = 0
            for each complete dice state D:
                total += initial_multiplicity[D] * roll2[D]

            F[index(M, u)] = total / 7776
```

---

## Appendix C — Query pseudocode

```text
function recommend(scorecard, dice, rerolls_remaining):
    context = validate_and_normalize(scorecard)
    (M, u, recorded_total) = context

    for each complete dice state D:
        scoring_actions[D] = []

        for each category c not in M:
            action = evaluate_score_action(M, u, D, c, F)
            scoring_actions[D].append(action)

        score_value[D] = max value in scoring_actions[D]

    roll0 = score_value

    if rerolls_remaining >= 1:
        keep0 = keeper_transform(roll0)
        roll1 = combine_score_and_reroll(score_value, keep0)

    if rerolls_remaining == 2:
        keep1 = keeper_transform(roll1)
        roll2 = combine_score_and_reroll(score_value, keep1)

    actions = scoring_actions[dice]

    if rerolls_remaining == 1:
        actions += legal_keeper_actions(dice, keep0)

    if rerolls_remaining == 2:
        actions += legal_keeper_actions(dice, keep1)

    certify_and_rank(actions)

    for action in actions:
        action.expected_final_total =
            recorded_total + action.expected_additional_points

    return decision_report(actions, context, metadata)
```

---

## Appendix D — Frozen interpretation checklist

The following are normative for `swedish-alga-free-order-v1`:

- [x] Five dice.
- [x] Two rerolls after the initial roll.
- [x] Scoring may occur early.
- [x] Categories may be filled in any order.
- [x] Any unused category may receive zero.
- [x] Upper bonus is 50 at 63.
- [x] Upper subtotal is capped at 63 in the solver state.
- [x] One Pair uses the highest qualifying pair.
- [x] A triple, four of a kind, or Yatzy may score in One Pair.
- [x] Two Pairs requires two distinct face values.
- [x] Four equal dice are not Two Pairs.
- [x] Three of a Kind scores exactly three equal dice.
- [x] Four of a Kind scores exactly four equal dice.
- [x] Small Straight is exactly 1–2–3–4–5 for 15.
- [x] Large Straight is exactly 2–3–4–5–6 for 20.
- [x] Full House requires distinct pair and triple values.
- [x] Yatzy is not a Full House.
- [x] Chance scores all five dice.
- [x] Yatzy scores 50.
- [x] No repeated-Yatzy bonus.
- [x] No Joker rule.
- [x] No-op rerolls are excluded.
- [x] Objective is expected final score.
- [x] All tied optimal actions are valid.
