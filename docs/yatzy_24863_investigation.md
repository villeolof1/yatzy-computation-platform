# Historical 248.63 Compatibility Investigation

The canonical solver implements the stated Swedish rule that Two Pairs requires two distinct pair values and obtains an exact starting expectation near 248.4399894.

Inspection of the released 2012 Java implementation showed that its generic pair scorer returns the value of the highest single pair when no second distinct pair exists. Reproducing only that historical behavior in an otherwise unchanged complete dynamic program yields 248.6328539, which rounds to the published 248.63.

The historical compatibility variant is therefore not the canonical ruleset. It should be labeled `kth-2012-implementation-compatible-v1` in any later comparison and kept distinct from the paper's correctly stated rules.
