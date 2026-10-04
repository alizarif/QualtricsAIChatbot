// Seedable random number generator (sfc32). The 4-word state lives in the
// session object so that a session can be reproduced from its seed and so
// that the stream survives a server restart.

export function seedState(seed) {
  let s = seed >>> 0;
  const out = [];
  for (let i = 0; i < 4; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    out.push((z ^ (z >>> 16)) >>> 0);
  }
  return out;
}

/** Returns a () => [0,1) function that advances `state` (array of 4 uint32) in place. */
export function rngFromState(state) {
  return () => {
    let [a, b, c, d] = state;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    state[0] = a >>> 0; state[1] = b >>> 0; state[2] = c >>> 0; state[3] = d >>> 0;
    return (t >>> 0) / 4294967296;
  };
}

export function shuffled(arr, rng) {
  const x = [...arr];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
