export const CATEGORY_IDS = [
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'one_pair', 'two_pairs', 'three_of_a_kind', 'four_of_a_kind',
  'small_straight', 'large_straight', 'full_house', 'chance', 'yatzy'
];

export const CATEGORY_NAMES = [
  'Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes',
  'One Pair', 'Two Pairs', 'Three of a Kind', 'Four of a Kind',
  'Small Straight', 'Large Straight', 'Full House', 'Chance', 'Yatzy'
];

export function diceToCounts(dice) {
  const counts = new Uint8Array(6);
  for (const die of dice) {
    if (!Number.isInteger(die) || die < 1 || die > 6) throw new Error(`Invalid die: ${die}`);
    counts[die - 1] += 1;
  }
  return counts;
}

export function countsToDice(counts) {
  const dice = [];
  for (let f = 0; f < 6; f += 1) for (let i = 0; i < counts[f]; i += 1) dice.push(f + 1);
  return dice;
}

export function scoreCategory(counts, category, options = {}) {
  if (category >= 0 && category <= 5) return counts[category] * (category + 1);
  switch (category) {
    case 6: { // Highest qualifying pair.
      for (let face = 5; face >= 0; face -= 1) if (counts[face] >= 2) return 2 * (face + 1);
      return 0;
    }
    case 7: { // Two distinct pairs.
      let first = 0;
      let second = 0;
      for (let face = 5; face >= 0; face -= 1) {
        if (counts[face] >= 2) {
          if (!first) first = face + 1;
          else { second = face + 1; break; }
        }
      }
      if (second) return 2 * (first + second);
      return options.twoPairSinglePairFallback && first ? 2 * first : 0;
    }
    case 8:
      for (let face = 5; face >= 0; face -= 1) if (counts[face] >= 3) return 3 * (face + 1);
      return 0;
    case 9:
      for (let face = 5; face >= 0; face -= 1) if (counts[face] >= 4) return 4 * (face + 1);
      return 0;
    case 10:
      return counts[0] === 1 && counts[1] === 1 && counts[2] === 1 && counts[3] === 1 && counts[4] === 1 ? 15 : 0;
    case 11:
      return counts[1] === 1 && counts[2] === 1 && counts[3] === 1 && counts[4] === 1 && counts[5] === 1 ? 20 : 0;
    case 12: {
      let triple = 0;
      let pair = 0;
      for (let face = 0; face < 6; face += 1) {
        if (counts[face] === 3) triple = face + 1;
        else if (counts[face] === 2) pair = face + 1;
      }
      return triple && pair ? 3 * triple + 2 * pair : 0;
    }
    case 13: {
      let total = 0;
      for (let face = 0; face < 6; face += 1) total += counts[face] * (face + 1);
      return total;
    }
    case 14:
      return counts.some(n => n === 5) ? 50 : 0;
    default:
      throw new Error(`Unknown category: ${category}`);
  }
}

export function buildScoreMatrix(rollCounts, options = {}) {
  const matrix = new Uint8Array(rollCounts.length * 15);
  for (let r = 0; r < rollCounts.length; r += 1) {
    for (let c = 0; c < 15; c += 1) matrix[r * 15 + c] = scoreCategory(rollCounts[r], c, options);
  }
  return matrix;
}
