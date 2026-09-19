# Simulation RNG correction (v2.0.3)

The exact Bellman table and serialized policy in v2.0.2 were correct. The publication simulation failed because each game created a fresh xorshift128 generator while only two of its four state words depended on the game seed. The remaining two words were constants. This created repeatable correlations in the early portion of every game's stream.

Observed with the affected implementation:

- exact expectation: 248.43998937785537
- ten-million-game simulated mean: 248.0882149
- discrepancy: -0.3517745 points (-28.86 standard errors)

A local one-million-game reproduction yielded 248.078516. After seeding all four words, a one-million-game validation yielded 248.493128, within ordinary Monte Carlo variation of the exact expectation.

v2.0.3 also replaces modulo reduction with rejection sampling so six-sided die draws are exactly uniform over the 32-bit generator output space. A mandatory 500,000-game pilot simulation now runs before the ten-million-game publication stage.
