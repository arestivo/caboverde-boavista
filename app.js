(() => {
  'use strict';
  const normalizePlaceName = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hiddenKeywords = (globalThis.BOAVISTA_CONFIG?.hiddenPlaceKeywords || []).map(normalizePlaceName).filter(Boolean);
  const visiblePlaces = globalThis.BOAVISTA_DATA.places.filter(place =>
    ![place.name, ...place.aliases].some(name => hiddenKeywords.some(keyword => normalizePlaceName(name).includes(keyword))));
  const visiblePlaceIds = new Set(visiblePlaces.map(place => place.id));
  const DATA = {
    ...globalThis.BOAVISTA_DATA,
    places: visiblePlaces,
    tours: globalThis.BOAVISTA_DATA.tours.map(tour => ({
      ...tour,
      places: tour.places.filter(place => visiblePlaceIds.has(place.id)),
    })),
  };
  const Solver = globalThis.TourSolver;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  const originalPlaces = new Map(DATA.places.map(p => [p.id, p]));
  const tourMap = new Map(DATA.tours.map(t => [t.id, t]));
  const STORAGE = 'boavista-planner-v1';
  const defaults = { selected: [], merges: [], travelers: 2, transit: false, uncertain: false, estimates: true, maxTours: 0 };
  let state = { ...defaults };
  let storageAvailable = true;
  let filter = 'all', query = '', limit = 20, searchBudget = 12000, job = 0, worker = null, timer = null;
  let resolved, placeMap, prepared, lastResult = null;

  function validated(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose an exported Boa Vista planner file.');
    const next = { ...defaults };
    if (Array.isArray(input.selected)) next.selected = [...new Set(input.selected.filter(id => originalPlaces.has(id)))];
    if (Array.isArray(input.merges)) {
      if (input.merges.length > 200) throw new Error('This file has too many place merges.');
      next.merges = input.merges.filter(m => m && originalPlaces.has(m.a) && originalPlaces.has(m.b) && m.a !== m.b)
        .map((m, i) => ({ a: m.a, b: m.b, id: typeof m.id === 'string' ? m.id.slice(0,80) : 'import-' + i }));
    }
    next.travelers = Math.min(12, Math.max(1, Math.round(Number(input.travelers) || 2)));
    for (const key of ['transit', 'uncertain', 'estimates']) if (typeof input[key] === 'boolean') next[key] = input[key];
    next.maxTours = [0, 1, 2, 3, 4, 5, 6].includes(Number(input.maxTours)) ? Number(input.maxTours) : 0;
    return next;
  }
  try { const saved = localStorage.getItem(STORAGE); if (saved) state = validated(JSON.parse(saved)); }
  catch { storageAvailable = false; }

  function persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); }
    catch { storageAvailable = false; }
    document.querySelector('.local-label').innerHTML = '<span class="status-dot"></span>' + (storageAvailable ? 'Saved on this device' : 'Changes saved for this visit');
  }

  function notify(message, error = false) {
    $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    clearTimeout(notify.timer); notify.timer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }
  function category(place) {
    if (/restaurant|shop|museum|church|chapel|fort|cultural|visitor centre|workshop/i.test(place.type)) return 'food';
    if (/beach|bay|islet|snorkel|wreck|harbour|lighthouse/i.test(place.type)) return 'coast';
    if (/village|town|neighbourhood|departure island/i.test(place.type)) return 'town';
    return 'inland';
  }
  const icons = { coast: '≈', inland: '△', town: '⌂', food: '◇' };

  function eligible(association) {
    if (association.evidence !== 'explicit' && !state.uncertain) return false;
    if (association.role === 'V') return true;
    if (['T', 'B'].includes(association.role)) return state.transit;
    return state.uncertain;
  }

  function prepare() {
    resolved = Solver.resolvePlaces(DATA.places, state.merges, globalThis.BOAVISTA_CONFIG?.mergePlaceKeywords || []);
    placeMap = new Map(resolved.groups.map(p => [p.id, p]));
    prepared = DATA.tours.filter(t => state.estimates || t.price.kind !== 'unclear').map(t => {
      const places = t.places.filter(eligible).map(a => ({ ...a, canonical: resolved.canonical[a.id] }));
      return { ...t, cost: Solver.priceForParty(t.price, state.travelers), placeIds: [...new Set(places.map(a => a.canonical))], eligiblePlaces: places };
    });
  }
  const selected = () => [...new Set(state.selected.map(id => resolved.canonical[id]).filter(Boolean))];
  function shortName(id) {
    return placeMap.get(id)?.name.replace(/ \((?:operator name|probably|itinerary pin|Gil Tours local name).*\)$/, '') || id;
  }
  function togglePlace(id) {
    const group = placeMap.get(id); if (!group) return;
    if (selected().includes(id)) state.selected = state.selected.filter(raw => resolved.canonical[raw] !== id);
    else state.selected.push(id);
    limit = 20; persist(); renderSelection(); renderPlaces(); scheduleSearch();
  }
  function renderPlaces() {
    const counts = new Map();
    for (const t of prepared) for (const id of t.placeIds) counts.set(id, (counts.get(id) || 0) + 1);
    const chosen = new Set(selected());
    const popular = ['santa-monica', 'varandinha-caves', 'morro-areia', 'cabo-wreck', 'viana', 'djeu', 'turtle-bay', 'shark-bay'];
    const places = resolved.groups.filter(p => (filter === 'all' || category(p) === filter) && (!query || normalize(p.aliases.join(' ')).includes(normalize(query))))
      .sort((a, b) => {
        const ai = popular.indexOf(a.id), bi = popular.indexOf(b.id);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.name.localeCompare(b.name);
      });
    const scroll = $('place-list').scrollTop;
    const focusedPlace = document.activeElement?.dataset?.place;
    $('place-list').innerHTML = places.map(p => {
      const count = counts.get(p.id) || 0;
      const merged = p.members.length > 1;
      const label = merged ? `${p.type} · ${p.members.length} merged names` : p.type;
      return `<label class="place-row ${chosen.has(p.id) ? 'selected' : ''}"><input type="checkbox" data-place="${escape(p.id)}" ${chosen.has(p.id) ? 'checked' : ''}><span class="place-info"><span class="place-name">${escape(shortName(p.id))}</span><span class="place-type">${escape(label)}${p.confidence !== 'high' ? ' · identity unverified' : ''}</span></span><span class="place-count ${count ? '' : 'zero'}" title="Tours matching your preferences">${count} ${count === 1 ? 'tour' : 'tours'}</span><span class="place-icon" aria-hidden="true">${icons[category(p)]}</span></label>`;
    }).join('') || '<p class="no-merges">No places match your search.</p>';
    $('place-list').scrollTop = scroll;
    if (focusedPlace) $('place-list').querySelector(`[data-place="${CSS.escape(focusedPlace)}"]`)?.focus({ preventScroll: true });
    $('data-footer').textContent = `${resolved.groups.length} places · ${DATA.tours.length} excursions · Works entirely in your browser`;
  }
  function renderSelection() {
    const ids = selected();
    $('selected-count').textContent = ids.length;
    $('mobile-count').textContent = ids.length;
    $('essential-chips').innerHTML = ids.map(id => `<button class="essential-chip" data-remove-place="${escape(id)}" aria-label="Remove ${escape(shortName(id))}">${escape(shortName(id))}<span aria-hidden="true">×</span></button>`).join('');
    $('clear-selection').disabled = !ids.length;
  }
  function cancelSearch() { job++; clearTimeout(timer); if (worker) { worker.terminate(); worker = null; } }
  function scheduleSearch(reset = true) {
    cancelSearch();
    if (reset) { searchBudget = 12000; lastResult = null; }
    if (!selected().length) { renderEmpty(); return; }
    $('result-status').textContent = 'Finding combinations for your essential places…';
    $('loading-indicator').hidden = false;
    $('result-actions').hidden = true;
    $('results').setAttribute('aria-busy', 'true');
    $('results').style.opacity = '.55';
    timer = setTimeout(runSearch, 120);
  }
  function renderEmpty() {
    $('results').style.opacity = '1'; $('results').removeAttribute('aria-busy');
    $('loading-indicator').hidden = true; $('result-actions').hidden = true;
    $('result-status').textContent = 'Start with the places that matter to you.';
    $('results').innerHTML = `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h3>A little island. A lot to discover.</h3><p>Choose your essential places on the left.<br>We’ll put together the fewest tours, at the best starting price.</p><button class="button button-primary" id="example-plan">Try the island highlights <span aria-hidden="true">↗</span></button><span class="example-text">Santa Mónica · Varandinha · Viana · the shipwreck</span></div>`;
  }

  function runSearch() {
    const token = job;
    const input = {
      selected: selected(), tours: prepared.map(t => ({ id: t.id, cost: t.cost, placeIds: t.placeIds })),
      limit, maxTours: state.maxTours, maxMillis: searchBudget, maxNodes: Math.round(searchBudget * 150),
    };
    const receive = message => {
      if (job !== token) return;
      if (message.type === 'progress') $('result-status').textContent = `Comparing ${message.data.searchingCount}-tour combinations…`;
      else { lastResult = message.data; renderResults(message.data); if (worker) { worker.terminate(); worker = null; } }
    };
    // A cooperative fallback also supports opening index.html directly from disk,
    // where browsers commonly block file:// workers.
    let fellBack = false;
    function fallback() {
      if (fellBack || token !== job) return;
      fellBack = true;
      if (worker) { worker.terminate(); worker = null; }
      const iterator = Solver.solve(input);
      const pump = () => {
        if (token !== job) return;
        const slice = performance.now();
        let step;
        do {
          step = iterator.next();
          if (step.done) { receive({ type: 'result', data: step.value }); return; }
          receive({ type: 'progress', data: step.value });
        } while (performance.now() - slice < 30);
        setTimeout(pump, 0);
      };
      setTimeout(pump, 0);
    }
    if (location.protocol === 'file:') { fallback(); return; }
    try {
      worker = new Worker('worker.js?v=20261115-2');
      worker.onmessage = event => receive(event.data);
      worker.onerror = event => { event.preventDefault(); fallback(); };
      worker.postMessage(input);
    } catch { fallback(); }
  }

  function tourHTML(tour, essential) {
    const selectedPlaces = essential.filter(id => tour.placeIds.includes(id));
    const covered = selectedPlaces.map(id => {
      const associations = tour.eligiblePlaces.filter(p => p.canonical === id);
      const certain = associations.some(p => p.role === 'V' && p.evidence === 'explicit');
      return `<span class="coverage-tag ${certain ? '' : 'uncertain'}">${certain ? '✓' : '◇'} ${escape(shortName(id))}</span>`;
    }).join('');
    let priceExplanation;
    if (tour.price.kind === 'group') {
      const units = Math.ceil(state.travelers / tour.price.capacity);
      priceExplanation = `${units} × ${money(tour.price.amount * 100)} group booking${units > 1 ? 's' : ''} (up to ${tour.price.capacity} each)`;
    } else priceExplanation = `${state.travelers} × ${money(tour.price.amount * 100)} ${tour.price.kind === 'unclear' ? 'assumed per adult · estimate' : 'per adult'}`;
    const allPlaces = [...new Set(tour.eligiblePlaces.map(a => shortName(a.canonical)))];
    return `<article class="tour-row"><div class="tour-heading"><a href="${escape(tour.url)}" target="_blank" rel="noopener noreferrer">${escape(tour.title)} <span class="external" aria-label="opens original listing">↗</span></a><span class="tour-price">${money(tour.cost)}</span></div><div class="tour-meta"><span>${escape(tour.duration || 'Duration varies')}</span>${tour.rating ? `<span>★ ${escape(tour.rating)} (${escape(tour.reviews)})</span>` : ''}<span>${escape(tour.provider || tour.category)}</span></div><div class="coverage-tags">${covered}</div><details class="tour-details"><summary>Tour details & pricing</summary><p>${escape(tour.summary)}</p><p><strong>${escape(priceExplanation)}</strong></p><p>Documented places: ${escape(allPlaces.join(' · ') || 'None named')}.</p>${tour.notes.length ? '<p>' + escape(tour.notes.join(' ')) + '</p>' : ''}</details></article>`;
  }

  function renderResults(result) {
    $('results').style.opacity = '1'; $('results').removeAttribute('aria-busy');
    $('loading-indicator').hidden = true;
    const essential = selected();
    if (result.uncovered.length) {
      $('result-status').textContent = 'Some places have no matching tours under these preferences.';
      $('results').innerHTML = `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">◇</span><h3>A few places need another look.</h3><p>These places have no eligible tours in the saved data:</p><ul class="unavailable-list">${result.uncovered.map(id => '<li>' + escape(shortName(id)) + '</li>').join('')}</ul><button class="button button-outline" id="adjust-preferences">Review preferences ↗</button><p style="margin-top:15px">Optional or unverified stops may offer more options.</p></div>`;
      $('result-actions').hidden = true; return;
    }
    if (!result.results.length) {
      $('result-status').textContent = result.complete ? 'No combination fits these preferences.' : 'Search paused before finding a complete combination.';
      $('results').innerHTML = `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">↗</span><h3>Give your itinerary a little room.</h3><p>${result.complete ? 'Try allowing more tours or changing your place preferences.' : 'This selection has many possibilities. Continue searching to explore more combinations.'}</p><button class="button button-outline" id="adjust-preferences">Review preferences ↗</button></div>`;
    } else {
      const first = result.results[0];
      $('result-status').textContent = result.complete ? `${result.results.length} combinations · covering all ${essential.length} essential places` : `Search paused · ${result.results.length} options found so far; ranking may improve`;
      $('results').innerHTML = result.results.map((plan, index) => {
        const tours = plan.tourIds.map(id => prepared.find(t => t.id === id));
        const estimated = tours.some(t => t.price.kind === 'unclear');
        const isBest = index === 0 && result.complete;
        const noun = tours.length === 1 ? 'tour' : 'tours';
        return `<section class="plan-card ${isBest ? 'best' : ''}"><div class="plan-header"><div class="plan-index"><span class="rank-number">${String(index + 1).padStart(2, '0')}</span><div><h3>${tours.length} ${noun}${isBest ? '<span class="best-badge">Best fit</span>' : ''}</h3><small>All ${essential.length} essentials covered</small></div></div><div class="plan-price"><strong>${money(plan.cost)}</strong><span>${estimated ? 'estimated ' : ''}total · ${state.travelers} ${state.travelers === 1 ? 'adult' : 'adults'}</span></div></div><div class="plan-tours">${tours.map(t => tourHTML(t, essential)).join('')}</div><div class="plan-bottom"><span>${estimated ? 'Includes assumed per-adult pricing' : 'Based on saved starting prices'}${!result.complete && tours.length > result.searchedThrough ? ' · search incomplete' : ''}</span><button class="text-button" data-export-combination="${index}">Save itinerary ↗</button></div></section>`;
      }).join('');
    }
    $('result-actions').hidden = !result.hasMore;
    $('load-more').hidden = !result.complete || !result.hasMore;
    $('search-longer').hidden = result.complete;
  }

  function renderMergeManager() {
    const sorted = [...resolved.groups].sort((a, b) => a.name.localeCompare(b.name));
    for (const id of ['merge-first', 'merge-second']) {
      const current = $(id).value;
      $(id).innerHTML = '<option value="">Choose a place…</option>' + sorted.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
      if (placeMap.has(current)) $(id).value = current;
    }
    $('merge-count').textContent = `${state.merges.length} ${state.merges.length === 1 ? 'change' : 'changes'}`;
    $('merge-list').innerHTML = state.merges.map(m => `<div class="merge-item"><span>${escape(originalPlaces.get(m.a).name)}<small>= ${escape(originalPlaces.get(m.b).name)}</small></span><button data-undo-merge="${escape(m.id)}" aria-label="Undo merge of ${escape(originalPlaces.get(m.a).name)} and ${escape(originalPlaces.get(m.b).name)}">Undo</button></div>`).join('') || '<p class="no-merges">No custom merges yet. Your local knowledge goes here.</p>';
  }
  function openManager() { renderMergeManager(); $('merge-feedback').textContent = ''; $('manage-dialog').showModal(); }
  function refresh() { prepare(); renderPlaces(); renderSelection(); scheduleSearch(); }
  function syncInputs() {
    $('travelers').value = state.travelers;
    $('allow-transit').checked = state.transit;
    $('allow-uncertain').checked = state.uncertain;
    $('allow-estimates').checked = state.estimates;
    $('max-tours').value = state.maxTours;
  }
  function exportJSON(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportChoices() { exportJSON({ format: STORAGE, ...state }, 'boa-vista-choices.json'); notify('Choices exported, including your place merges.'); }
  function setTravelers(value) {
    state.travelers = Math.max(1, Math.min(12, Math.round(Number(value) || 1)));
    $('travelers').value = state.travelers;
    limit = 20; persist(); refresh();
  }
  $('place-list').addEventListener('change', event => { if (event.target.dataset.place) togglePlace(event.target.dataset.place); });
  $('essential-chips').addEventListener('click', event => { const button = event.target.closest('[data-remove-place]'); if (button) togglePlace(button.dataset.removePlace); });
  $('place-search').addEventListener('input', event => { query = event.target.value; renderPlaces(); });
  $('place-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]'); if (!button) return;
    filter = button.dataset.filter;
    $('place-filters').querySelectorAll('button').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', b === button ? 'true' : 'false'); });
    renderPlaces();
  });
  $('clear-selection').onclick = () => { state.selected = []; persist(); renderSelection(); renderPlaces(); scheduleSearch(); };
  $('travelers').onchange = event => setTravelers(event.target.value);
  $('travelers-minus').onclick = () => setTravelers(state.travelers - 1);
  $('travelers-plus').onclick = () => setTravelers(state.travelers + 1);
  for (const [id, key] of [['allow-transit', 'transit'], ['allow-uncertain', 'uncertain'], ['allow-estimates', 'estimates']]) {
    $(id).onchange = event => { state[key] = event.target.checked; limit = 20; persist(); refresh(); };
  }
  $('max-tours').onchange = event => { state.maxTours = Number(event.target.value); limit = 20; persist(); scheduleSearch(); };
  function openTourOptions() {
    if (!$('preferences-dialog').open) $('preferences-dialog').showModal();
    $('settings-toggle').setAttribute('aria-expanded', 'true');
  }
  $('settings-toggle').onclick = openTourOptions;
  $('preferences-close').onclick = () => $('preferences-dialog').close();
  $('preferences-done').onclick = () => $('preferences-dialog').close();
  $('preferences-dialog').addEventListener('close', () => $('settings-toggle').setAttribute('aria-expanded', 'false'));
  $('preferences-dialog').addEventListener('click', event => {
    if (event.target !== $('preferences-dialog')) return;
    const r = event.target.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close();
  });
  $('results').addEventListener('click', event => {
    if (event.target.closest('#example-plan')) {
      state.selected = ['santa-monica', 'varandinha-caves', 'viana', 'cabo-wreck']; limit = 20; persist(); refresh();
      if (matchMedia('(max-width:700px)').matches) $('results-panel').scrollIntoView({ behavior: 'smooth' });
    }
    if (event.target.closest('#adjust-preferences')) openTourOptions();
    const save = event.target.closest('[data-export-combination]');
    if (save && lastResult) {
      const plan = lastResult.results[Number(save.dataset.exportCombination)];
      exportJSON({ ...state, dataDate: DATA.date, estimatedUSD: plan.cost / 100,
        essentialPlaces: selected().map(id => shortName(id)),
        tours: plan.tourIds.map(id => ({ title: tourMap.get(id).title, url: tourMap.get(id).url })) }, 'boa-vista-itinerary.json');
    }
  });
  $('load-more').onclick = () => { limit += 20; scheduleSearch(false); };
  $('search-longer').onclick = () => { searchBudget = Math.min(120000, searchBudget * 3); scheduleSearch(false); };
  $('mobile-results').onclick = () => { $('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('manage-open').onclick = openManager;
  $('merge-shortcut').onclick = openManager;
  $('manage-close').onclick = () => $('manage-dialog').close();
  $('manage-dialog').addEventListener('click', event => { if (event.target === $('manage-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
  $('merge-form').onsubmit = event => {
    event.preventDefault();
    const a = $('merge-first').value, b = $('merge-second').value;
    if (!a || !b) { $('merge-feedback').textContent = 'Choose two places to merge.'; return; }
    if (a === b || resolved.canonical[a] === resolved.canonical[b]) { $('merge-feedback').textContent = 'Those already represent the same place.'; return; }
    const left = shortName(a), right = shortName(b);
    state.merges.push({ a, b, id: 'merge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
    persist(); limit = 20; refresh(); renderMergeManager();
    $('merge-feedback').textContent = `${left} and ${right} now count as one place.`;
    $('merge-second').value = '';
    notify('Places merged. Tour combinations updated.');
  };
  $('merge-list').onclick = event => {
    const button = event.target.closest('[data-undo-merge]'); if (!button) return;
    state.merges = state.merges.filter(m => m.id !== button.dataset.undoMerge);
    persist(); refresh(); renderMergeManager(); $('merge-feedback').textContent = 'Merge undone. Original places restored.';
  };
  $('export-settings').onclick = exportChoices;
  $('export-plan').onclick = exportChoices;
  $('import-settings').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 500000) throw new Error('Choose a smaller planner export file.');
      const input = JSON.parse(await file.text());
      if (input.format !== STORAGE) throw new Error('Choose a Boa Vista choices export, not an itinerary or another JSON file.');
      state = validated(input); persist(); syncInputs(); refresh(); renderMergeManager();
      $('merge-feedback').textContent = 'Choices and merges imported.'; notify('Your choices and place merges have been restored.');
    } catch (error) { $('merge-feedback').textContent = error.message; notify(error.message, true); }
    event.target.value = '';
  };
  syncInputs(); prepare(); persist(); renderPlaces(); renderSelection(); scheduleSearch();
})();
