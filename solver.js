(function (scope) {
  'use strict';
  const popcount = value => { let count = 0; while (value) { value &= value - 1n; count++; } return count; };
  const compare = (a, b) => a.tourIds.length - b.tourIds.length || a.cost - b.cost || a.tourIds.join(',').localeCompare(b.tourIds.join(','));

  function resolvePlaces(places, merges, mergeKeywords = []) {
    const normalizeName = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const parent = new Map(places.map(p => [p.id, p.id]));
    const find = id => {
      if (!parent.has(id)) return null;
      let current = id;
      while (parent.get(current) !== current) current = parent.get(current);
      while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, current); id = next; }
      return current;
    };
    for (const keyword of mergeKeywords.map(normalizeName).filter(Boolean)) {
      const matching = places.filter(place => [place.name, ...place.aliases]
        .some(name => normalizeName(name).includes(keyword)));
      const representative = matching.find(place => normalizeName(place.name) === keyword)
        || matching.find(place => place.aliases.some(name => normalizeName(name) === keyword))
        || matching[0];
      if (!representative) continue;
      for (const place of matching) {
        const a = find(representative.id), b = find(place.id);
        if (a !== b) parent.set(b, a);
      }
    }
    for (const merge of merges) {
      const a = find(merge.a), b = find(merge.b);
      if (a && b && a !== b) parent.set(b, a);
    }
    const groups = new Map();
    for (const place of places) {
      const id = find(place.id);
      if (!groups.has(id)) groups.set(id, { ...places.find(p => p.id === id), members: [], aliases: [] });
      const group = groups.get(id);
      group.members.push(place.id);
      group.aliases.push(place.name, ...place.aliases);
    }
    for (const group of groups.values()) group.aliases = [...new Set(group.aliases)];
    return { groups: [...groups.values()], canonical: Object.fromEntries(places.map(p => [p.id, find(p.id)])) };
  }

  function priceForParty(price, travelers) {
    if (!price || !Number.isFinite(price.amount) || price.amount < 0) return null;
    const units = price.kind === 'group' ? Math.ceil(travelers / price.capacity) : travelers;
    return Math.round(price.amount * 100) * units;
  }

  // Exact set-cover enumeration. Branches are disjoint: when a place has several
  // suppliers, each branch excludes earlier suppliers at that decision point.
  // Only inclusion-minimal covers are returned (every tour adds an essential place).
  function* solve(input) {
    const selected = [...new Set(input.selected)];
    if (!selected.length) return { results: [], complete: true, hasMore: false, nodes: 0, uncovered: [] };
    const bits = new Map(selected.map((id, i) => [id, 1n << BigInt(i)]));
    const full = (1n << BigInt(selected.length)) - 1n;
    const candidates = input.tours.map(t => ({ ...t, mask: [...new Set(t.placeIds)].reduce((m, id) => m | (bits.get(id) || 0n), 0n) }))
      .filter(t => t.mask && Number.isFinite(t.cost) && t.cost >= 0)
      .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
    const all = candidates.reduce((m, t) => m | t.mask, 0n);
    const uncovered = selected.filter(id => !(bits.get(id) & all));
    if (uncovered.length) return { results: [], complete: true, hasMore: false, nodes: 0, uncovered };
    const limit = input.limit || 20;
    const maxTours = Math.min(input.maxTours || selected.length, selected.length, candidates.length);
    const start = Date.now();
    let nodes = 0, stopped = false, results = [], searchingCount = 0, searchedThrough = 0, hasMore = false;
    const maxNodes = input.maxNodes ?? 1500000;
    const maxMillis = input.maxMillis ?? 12000;
    const budget = function* () {
      nodes++;
      if ((nodes & 255) === 0) {
        yield { nodes, searchingCount, found: results.length, elapsed: Date.now() - start };
        if (nodes > maxNodes || Date.now() - start > maxMillis) stopped = true;
      }
    };
    for (let count = 1; count <= maxTours && !stopped; count++) {
      searchingCount = count;
      const needed = limit - results.length;
      let best = [], discarded = false;
      const visit = function* (chosen, covered, cost, banned) {
        yield* budget();
        if (stopped) return;
        if (covered === full) {
          if (chosen.length !== count) return;
          const result = { tourIds: chosen.map(i => candidates[i].id).sort(), cost };
          best.push(result); best.sort(compare);
          if (best.length > needed) { best.pop(); discarded = true; }
          return;
        }
        const slots = count - chosen.length;
        if (!slots) return;
        const missing = full & ~covered;
        const available = [];
        let union = 0n, biggestGain = 0;
        for (let i = 0; i < candidates.length; i++) {
          if (banned.has(i) || chosen.includes(i)) continue;
          const gain = candidates[i].mask & missing;
          if (!gain) continue;
          available.push(i); union |= gain;
          biggestGain = Math.max(biggestGain, popcount(gain));
        }
        if (union !== missing || Math.ceil(popcount(missing) / biggestGain) > slots || available.length < slots) return;
        if (best.length === needed) {
          const lowerPrice = cost + available.slice(0, slots).reduce((sum, i) => sum + candidates[i].cost, 0);
          if (lowerPrice > best[best.length - 1].cost) { discarded = true; return; }
        }
        let suppliers = null;
        for (const bit of bits.values()) {
          if (!(bit & missing)) continue;
          const options = available.filter(i => candidates[i].mask & bit);
          if (!suppliers || options.length < suppliers.length) suppliers = options;
        }
        const branchBanned = new Set(banned);
        for (const index of suppliers) {
          if (stopped) return;
          const next = [...chosen, index];
          // Once a chosen tour is redundant, adding more tours cannot fix it.
          const minimal = next.every(i => {
            const others = next.reduce((m, j) => i === j ? m : m | candidates[j].mask, 0n);
            return Boolean(candidates[i].mask & ~others);
          });
          if (minimal) yield* visit(next, covered | candidates[index].mask, cost + candidates[index].cost, new Set(branchBanned));
          branchBanned.add(index);
        }
      };
      yield* visit([], 0n, 0, new Set());
      results.push(...best);
      results.sort(compare);
      if (!stopped) searchedThrough = count;
      if (results.length >= limit) { hasMore = discarded || count < maxTours; break; }
    }
    return { results, complete: !stopped, hasMore: hasMore || stopped, nodes, uncovered: [], searchingCount, searchedThrough, elapsed: Date.now() - start };
  }

  const api = { solve, compare, resolvePlaces, priceForParty };
  scope.TourSolver = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
