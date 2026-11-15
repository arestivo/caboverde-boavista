// Places whose name or any alternate name contains one of these keywords are
// hidden from the planner. Matching ignores case, accents and punctuation.
globalThis.BOAVISTA_CONFIG = {
  hiddenPlaceKeywords: [
    'sal rei',
    'djeu',
  ],
  // Each keyword merges all matching visible places into one choice.
  // Names and alternate names are checked; an exact name is kept when possible.
  mergePlaceKeywords: [
    'rabil', 'varandinha',
  ],
};
