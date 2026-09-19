# Numerical value enclosure

The production solver uses IEEE-754 binary64 midpoint arithmetic and attaches a conservative absolute-error envelope to every turn-boundary value.

All Bellman values and rewards are non-negative and below 424. For a state with one additional turn, the calculation consists of scoring additions, maxima, two six-child keeper averages, and one 252-term multinomial expectation. Maxima are non-expansive: if every candidate approximation is within `e`, the maximum approximation is also within `e` of the true maximum, even when rounding changes the selected candidate.

Using the standard floating-point model `fl(x op y) = (x op y)(1 + δ)`, `|δ| ≤ u`, and the sequential-sum bound `γ_n = nu/(1-nu)`, the dominant 252-term expectation contributes well below `1e-7` absolute error per remaining turn at the score scale of this game. The keeper transforms and reward additions are smaller. The artifact deliberately allows `1e-6` per remaining turn, an order-of-magnitude safety factor, plus one representable outward step at each endpoint.

For a state with `r` turns remaining, the stored enclosure is therefore:

```text
[midpoint - (r + 1) × 1e-6, midpoint + (r + 1) × 1e-6]
```

with `nextDown` and `nextUp` applied to the endpoints. The terminal layer is exactly zero. A second build with a different worker count must produce an identical midpoint payload. The enclosure is intentionally wider than observed cross-build drift and is used for value-level numerical certification; exact action ties are reported separately from sampled action-margin analysis.
