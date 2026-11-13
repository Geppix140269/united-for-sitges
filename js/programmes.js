/* United for Sitges: programme comparison page.
   Static, dependency-free. Reads the version-controlled dataset in /data/.
   No scores, rankings or recommendations are computed anywhere in this file. */
(function () {
  'use strict';

  var PT = window.UFS_PROGRAMME_I18N || { en: {} };
  var LANGS = ['en', 'es', 'ca', 'it', 'fr', 'de', 'nl'];
  var LANG_NAMES = { ca: 'Catalan', es: 'Spanish', en: 'English' };
  var MAX_COMPARE = 4;

  var state = {
    lang: 'en',
    year: '2023',
    mode: 'subject',
    cat: null,
    order: 'alpha',
    party: null,
    cmpCat: null,
    cmpParties: []
  };
  var DATA = null;

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function t(key) {
    var d = PT[state.lang] || {};
    return d[key] != null ? d[key] : (PT.en[key] != null ? PT.en[key] : key);
  }
  function tf(key, vars) {
    return t(key).replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; });
  }
  function catName(cat) {
    return (cat.name && (cat.name[state.lang] || cat.name.en)) || cat.id;
  }
  function langName(code) {
    return t('lang_' + code) !== 'lang_' + code ? t('lang_' + code) : (LANG_NAMES[code] || code);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    try {
      var d = new Date(Date.UTC(+parts[0], +(parts[1] || 1) - 1, +(parts[2] || 1)));
      var opts = parts.length === 3 ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
        : parts.length === 2 ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { year: 'numeric', timeZone: 'UTC' };
      return d.toLocaleDateString(state.lang, opts);
    } catch (e) { return iso; }
  }
  function fmtNum(n) {
    try { return Number(n).toLocaleString(state.lang); } catch (e) { return String(n); }
  }
  function partyById(id) { return DATA.partyIndex[id]; }
  function sourceById(id) { return DATA.sourceIndex[id]; }

  function orderedParties() {
    var list = DATA.parties.slice();
    if (state.order === 'votes') {
      list.sort(function (a, b) { return (b.results_2023.votes || 0) - (a.results_2023.votes || 0); });
    } else {
      list.sort(function (a, b) { return a.sort_name.localeCompare(b.sort_name, 'ca'); });
    }
    return list;
  }

  function proposalsFor(partyId, catId, year) {
    return DATA.proposals.filter(function (p) {
      return p.party_id === partyId && String(p.election_year) === String(year) &&
        (!catId || p.categories.indexOf(catId) !== -1);
    });
  }

  function partyHasProgramme(party, year) {
    return DATA.sources.some(function (s) {
      return s.party_id === party.id && String(s.election_year) === String(year) && s.document_type === 'election_programme';
    });
  }

  function monogram(p) {
    return esc(p.monogram || p.short_name.slice(0, 3).toUpperCase());
  }

  function resultLine(p) {
    var r = p.results_2023;
    return tf('resultLine', { votes: fmtNum(r.votes), pct: fmtNum(r.pct), seats: r.seats });
  }

  /* ---------- proposal rendering ---------- */
  function proposalHtml(p, opts) {
    opts = opts || {};
    var src = sourceById(p.source_id) || {};
    var yearBadge = p.election_year === 2027
      ? '<span class="badge y2027">' + esc(t('badge2027')) + '</span>'
      : '<span class="badge hist">' + esc(t(p.evidence_label === 'SECONDARY_REPORTING' ? 'badge2023media' : 'badge2023')) + '</span>';
    // 2023 programme items already carry the 'historical reference' badge; other evidence types are labelled explicitly.
    var kind = p.evidence_label !== 'HISTORICAL_PROPOSAL' ? '<span class="badge kind">' + esc(t('ev_' + p.evidence_label)) + '</span>' : '';
    var commit = p.commitment_type ? '<span class="badge kind">' + esc(t('ct_' + p.commitment_type)) + '</span>' : '';
    var comp = (p.competence && p.competence !== 'municipal')
      ? '<span class="badge kind" title="' + esc(p.competence_note || '') + '">' + esc(t('comp_' + p.competence)) + '</span>' : '';
    var party = opts.showParty ? '<div class="meta" style="font-size:12.5px;font-weight:800;color:#556776">' + esc(partyById(p.party_id).short_name) + '</div>' : '';
    var where = [src.title ? esc(src.title) : '', p.source_page ? esc(t('pageAbbr')) + ' ' + esc(p.source_page) : '', p.source_section ? '“' + esc(p.source_section) + '”' : '']
      .filter(Boolean).join(', ');
    var srcLine = '<div class="src">' + esc(t('source')) + ': ' +
      (src.url ? '<a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + where + '</a>' : where) +
      ' <span class="muted" style="font-weight:600">(' + esc(tf('originalIn', { lang: langName(src.language || p.excerpt_lang) })) + ')</span></div>';
    var exc = p.excerpt_original
      ? '<details class="excerpt"><summary>' + esc(tf('originalWording', { lang: langName(p.excerpt_lang) })) + '</summary><blockquote lang="' + esc(p.excerpt_lang) + '">' + esc(p.excerpt_original) + '</blockquote></details>'
      : '';
    var dates = '<div class="small-note" style="margin:2px 0 0">' + esc(t('verified')) + ' ' + esc(fmtDate(p.date_verified)) +
      (src.publication_date ? ' · ' + esc(t('published')) + ' ' + esc(fmtDate(src.publication_date)) : '') + '</div>';
    return '<li class="proposal" id="' + esc(p.id) + '">' + party +
      '<h4>' + esc(p.title_en) + '</h4>' +
      '<div class="badges">' + yearBadge + kind + commit + comp + '</div>' +
      '<p>' + esc(p.summary_en) + '</p>' +
      (comp && p.competence_note ? '<p class="small-note" style="margin:-4px 0 8px">' + esc(t('competenceLabel')) + ' ' + esc(p.competence_note) + '</p>' : '') +
      srcLine + exc + dates + '</li>';
  }

  function missingHtml(party, year, catId) {
    if (!partyHasProgramme(party, year)) {
      var media = proposalsFor(party.id, null, year).length ? ' ' + esc(t('mediaElsewhere')) : '';
      return '<div class="missing"><strong>' + esc(t(year === '2027' ? 'no2027' : 'noProgramme2023')) + '</strong> ' + esc(t('noProgrammeHint')) + media + '</div>';
    }
    return '<div class="missing">' + esc(t(catId ? 'noneInCategory' : 'noneRecorded')) + '</div>';
  }

  function summaryNote() {
    return state.lang === 'en' ? '' : '<p class="small-note">' + esc(t('englishOnlyNote')) + '</p>';
  }

  /* ---------- MODE A: by subject ---------- */
  function renderChips() {
    var box = document.getElementById('categoryChips');
    box.innerHTML = DATA.taxonomy.map(function (c) {
      var n = DATA.proposals.filter(function (p) { return p.election_year === 2023 && p.categories.indexOf(c.id) !== -1; }).length;
      return '<button type="button" data-cat="' + esc(c.id) + '" aria-pressed="' + (c.id === state.cat) + '">' +
        esc(c.id + ' ' + catName(c)) + '<span class="n" aria-label="' + esc(tf('nProposals', { n: n })) + '">' + n + '</span></button>';
    }).join('');
  }

  function renderSubject() {
    var out = document.getElementById('subjectResults');
    var cat = DATA.taxonomyIndex[state.cat];
    var html = '<h3 style="color:#1F3864;margin:0 0 6px">' + esc(cat.id + ' · ' + catName(cat)) + '</h3>';
    if (cat.scope) html += '<p class="small-note" style="margin:0 0 16px">' + esc(t('includes')) + ' ' + esc((cat.scope[state.lang] || cat.scope.en)) + '</p>';
    html += summaryNote();
    html += '<div class="party-grid">';
    orderedParties().forEach(function (party) {
      var list = proposalsFor(party.id, state.cat, 2023);
      html += '<article class="party-card" aria-label="' + esc(party.short_name) + '"><div class="party-head"><span class="mono" aria-hidden="true">' + monogram(party) + '</span><div><h3>' + esc(party.short_name) + '</h3><div class="meta">' + esc(resultLine(party)) + '</div></div></div>';
      html += list.length ? '<ul class="proposals">' + list.map(function (p) { return proposalHtml(p); }).join('') + '</ul>' : missingHtml(party, '2023', state.cat);
      html += '</article>';
    });
    html += '</div><p class="small-note" style="margin-top:14px">' + esc(t('summaryLabel')) + '</p>';
    out.innerHTML = html;
  }

  /* ---------- MODE B: by party ---------- */
  function renderPartySelect() {
    var sel = document.getElementById('partySel');
    sel.innerHTML = orderedParties().map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === state.party ? ' selected' : '') + '>' + esc(p.short_name) + '</option>';
    }).join('');
  }

  function docItem(s) {
    return '<li><strong>' + esc(s.title) + '</strong><br>' +
      esc(t('dt_' + s.document_type)) + ' · ' + esc(s.publisher) + ' · ' + esc(tf('originalIn', { lang: langName(s.language) })) +
      (s.pages ? ' · ' + esc(tf('nPages', { n: s.pages })) : '') +
      (s.publication_date ? ' · ' + esc(t('published')) + ' ' + esc(fmtDate(s.publication_date)) : '') +
      ' · ' + esc(t('verified')) + ' ' + esc(fmtDate(s.date_verified)) +
      (s.completeness === 'partial' ? ' · <span class="badge warn">' + esc(t('partialDoc')) + '</span>' : '') +
      '<br><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(t('openSource')) + '</a>' +
      (s.notes_public ? '<div class="small-note" style="margin-top:4px">' + esc(s.notes_public) + '</div>' : '') + '</li>';
  }

  function renderParty() {
    var out = document.getElementById('partyResults');
    var p = partyById(state.party);
    var docs = DATA.sources.filter(function (s) { return s.party_id === p.id; });
    var html = '<div class="party-panel"><div class="party-head"><span class="mono" aria-hidden="true">' + monogram(p) + '</span><div><h3 style="font-size:22px">' + esc(p.short_name) + '</h3><div class="meta">' + esc(p.name_2023_official) + '</div></div></div>';
    html += '<dl>' +
      '<dt>' + esc(t('d_ballotName')) + '</dt><dd>' + esc(p.name_2023_official) + ' (' + esc(p.abbreviation_2023) + ')</dd>' +
      '<dt>' + esc(t('d_result2023')) + '</dt><dd>' + esc(resultLine(p)) + ' · <a href="' + esc(DATA.meta.results_source_url) + '" target="_blank" rel="noopener">BOE</a></dd>' +
      '<dt>' + esc(t('d_council')) + '</dt><dd>' + esc(p.council_status_2026[state.lang] || p.council_status_2026.en) + '</dd>' +
      (p.history_note ? '<dt>' + esc(t('d_history')) + '</dt><dd>' + esc(p.history_note[state.lang] || p.history_note.en) + ' <a href="' + esc(p.history_source_url) + '" target="_blank" rel="noopener">' + esc(t('source')) + '</a></dd>' : '') +
      '<dt>' + esc(t('d_prog2023')) + '</dt><dd>' + esc(t('ps_' + p.programme_2023_status)) + '</dd>' +
      '<dt>' + esc(t('d_prog2027')) + '</dt><dd>' + esc(t('ps_' + p.programme_2027_status)) + '</dd>' +
      (p.website ? '<dt>' + esc(t('d_website')) + '</dt><dd><a href="' + esc(p.website) + '" target="_blank" rel="noopener">' + esc(p.website.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a></dd>' : '') +
      '</dl>';
    (p.unverified_leads || []).forEach(function (u) {
      html += '<div class="missing" style="margin-top:14px"><span class="badge warn">' + esc(t('ev_NOT_YET_VERIFIED')) + '</span> ' + esc(t('unverifiedLead')) + ' <code style="word-break:break-all">' + esc(u.url) + '</code></div>';
    });
    html += '<h4 style="margin:22px 0 4px;color:#1F3864">' + esc(t('documents')) + '</h4>';
    html += docs.length ? '<ul class="doc-list">' + docs.map(docItem).join('') + '</ul>' : '<div class="missing">' + esc(t('noDocs')) + '</div>';
    html += '</div>';
    var all = proposalsFor(p.id, null, 2023);
    html += '<h3 style="color:#1F3864">' + esc(tf('proposals2023Title', { n: all.length })) + '</h3>' + summaryNote();
    if (!all.length) {
      html += missingHtml(p, '2023', null);
    } else {
      DATA.taxonomy.forEach(function (c) {
        var list = all.filter(function (x) { return x.categories[0] === c.id; });
        if (!list.length) return;
        html += '<div class="cat-block"><h3>' + esc(c.id + ' · ' + catName(c)) + '</h3><ul class="proposals party-card">' + list.map(function (x) { return proposalHtml(x); }).join('') + '</ul></div>';
      });
      html += '<p class="small-note">' + esc(t('primaryCatNote')) + '</p>';
    }
    out.innerHTML = html;
  }

  /* ---------- side by side ---------- */
  function renderCompareControls() {
    var sel = document.getElementById('cmpCat');
    sel.innerHTML = DATA.taxonomy.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === state.cmpCat ? ' selected' : '') + '>' + esc(c.id + ' ' + catName(c)) + '</option>';
    }).join('');
    var box = document.getElementById('cmpParties');
    box.innerHTML = orderedParties().map(function (p) {
      var on = state.cmpParties.indexOf(p.id) !== -1;
      var full = !on && state.cmpParties.length >= MAX_COMPARE;
      return '<label><input type="checkbox" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + (full ? ' disabled' : '') + '> ' + esc(p.short_name) + '</label>';
    }).join('');
  }

  function renderCompare() {
    var out = document.getElementById('cmpResults');
    var chosen = orderedParties().filter(function (p) { return state.cmpParties.indexOf(p.id) !== -1; });
    if (!chosen.length) { out.innerHTML = '<p class="empty">' + esc(t('pickPartiesHint')) + '</p>'; return; }
    var cat = DATA.taxonomyIndex[state.cmpCat];
    var html = summaryNote() + '<div class="cmp-wrap"><table class="cmp-table"><caption class="sr-only">' + esc(cat.id + ' ' + catName(cat)) + '</caption><thead><tr>' +
      chosen.map(function (p) { return '<th scope="col">' + esc(p.short_name) + '</th>'; }).join('') + '</tr></thead><tbody><tr>';
    chosen.forEach(function (p) {
      var list = proposalsFor(p.id, state.cmpCat, 2023);
      html += '<td data-label="' + esc(p.short_name) + '">' +
        (list.length ? '<ul class="proposals">' + list.map(function (x) { return proposalHtml(x); }).join('') + '</ul>' : missingHtml(p, '2023', state.cmpCat)) + '</td>';
    });
    html += '</tr></tbody></table></div><p class="small-note" style="margin-top:12px">' + esc(t('summaryLabel')) + '</p>';
    out.innerHTML = html;
  }

  /* ---------- 2027 status ---------- */
  function render2027() {
    var box = document.getElementById('status2027');
    box.innerHTML = orderedParties().map(function (p) {
      var items = (p.status_2027_items || []).map(function (it) {
        return '<p><span class="badge kind">' + esc(t('ev_' + it.evidence_label)) + '</span> ' + esc(it.text[state.lang] || it.text.en) +
          ' <a href="' + esc(it.source_url) + '" target="_blank" rel="noopener">' + esc(t('source')) + '</a> <span class="small-note">(' + esc(fmtDate(it.source_date)) + ')</span></p>';
      }).join('');
      return '<div class="status-item"><h3>' + esc(p.short_name) + '</h3>' +
        '<p><span class="badge ' + (p.programme_2027_status === 'verified' ? 'y2027' : 'warn') + '">' + esc(t('ps_' + p.programme_2027_status)) + '</span></p>' +
        '<p class="small-note">' + esc(p.council_status_2026[state.lang] || p.council_status_2026.en) + '</p>' + items + '</div>';
    }).join('');
  }

  /* ---------- coverage ---------- */
  function renderCoverage() {
    var box = document.getElementById('coverageTable');
    var head = '<thead><tr><th scope="col">' + esc(t('party')) + '</th>' + DATA.taxonomy.map(function (c) {
      return '<th scope="col" title="' + esc(catName(c)) + '"><abbr title="' + esc(catName(c)) + '">' + esc(c.id) + '</abbr></th>';
    }).join('') + '<th scope="col">' + esc(t('total')) + '</th></tr></thead>';
    var rows = orderedParties().map(function (p) {
      var hasProg = partyHasProgramme(p, '2023');
      if (!hasProg && !proposalsFor(p.id, null, 2023).length) {
        return '<tr><th scope="row">' + esc(p.short_name) + '</th><td class="nodoc" colspan="' + (DATA.taxonomy.length + 1) + '">' + esc(t('noProgramme2023')) + '</td></tr>';
      }
      var cells = DATA.taxonomy.map(function (c) {
        var n = proposalsFor(p.id, c.id, 2023).length;
        return '<td class="' + (n ? '' : 'zero') + '">' + n + '</td>';
      }).join('');
      var total = proposalsFor(p.id, null, 2023).length;
      var label = esc(p.short_name) + (hasProg ? '' : ' <span class="badge warn" style="font-size:10px">' + esc(t('mediaOnly')) + '</span>');
      return '<tr><th scope="row">' + label + '</th>' + cells + '<td><strong>' + total + '</strong></td></tr>';
    }).join('');
    var legend = '<p class="small-note" style="padding:10px 12px;margin:0">' + DATA.taxonomy.map(function (c) { return esc(c.id + ' ' + catName(c)); }).join(' · ') + '</p>' +
      '<p class="small-note" style="padding:0 12px 10px;margin:0">' + esc(t('multiTagNote')) + '</p>';
    box.innerHTML = '<table class="coverage"><caption class="sr-only">' + esc(t('coverageTitle')) + '</caption>' + head + '<tbody>' + rows + '</tbody></table>' + legend;
  }

  /* ---------- state, URL and language ---------- */
  function syncUrl() {
    var q = new URLSearchParams();
    q.set('year', state.year);
    if (state.year === '2023') {
      q.set('view', state.mode);
      if (state.mode === 'subject') q.set('cat', state.cat);
      if (state.mode === 'party') q.set('party', state.party);
      if (state.mode === 'compare') { q.set('cat', state.cmpCat); if (state.cmpParties.length) q.set('parties', state.cmpParties.join(',')); }
    }
    try { history.replaceState(null, '', location.pathname + '?' + q.toString() + location.hash); } catch (e) { /* ignore */ }
  }

  function readUrl() {
    var q = new URLSearchParams(location.search);
    if (q.get('year') === '2027') state.year = '2027';
    var v = q.get('view');
    if (['subject', 'party', 'compare'].indexOf(v) !== -1) state.mode = v;
    var c = q.get('cat');
    if (c && DATA.taxonomyIndex[c]) { state.cat = c; state.cmpCat = c; }
    var p = q.get('party');
    if (p && DATA.partyIndex[p]) state.party = p;
    var ps = (q.get('parties') || '').split(',').filter(function (x) { return DATA.partyIndex[x]; });
    if (ps.length) state.cmpParties = ps.slice(0, MAX_COMPARE);
  }

  function setYear(y) {
    state.year = y;
    document.getElementById('btn2023').setAttribute('aria-pressed', String(y === '2023'));
    document.getElementById('btn2027').setAttribute('aria-pressed', String(y === '2027'));
    document.getElementById('view2023').hidden = y !== '2023';
    document.getElementById('view2027').hidden = y !== '2027';
    syncUrl();
  }

  function setMode(m, focus) {
    state.mode = m;
    ['subject', 'party', 'compare'].forEach(function (k) {
      var tab = document.getElementById('tab-' + k);
      var on = k === m;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById('panel-' + k).hidden = !on;
      if (on && focus) tab.focus();
    });
    syncUrl();
  }

  function renderAll() {
    renderChips();
    renderSubject();
    renderPartySelect();
    renderParty();
    renderCompareControls();
    renderCompare();
    render2027();
    renderCoverage();
  }

  function applyStatic() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-pt]').forEach(function (el) { el.textContent = t(el.getAttribute('data-pt')); });
    document.getElementById('language').value = state.lang;
    var rd = document.getElementById('reviewedDate');
    if (DATA) { rd.textContent = fmtDate(DATA.meta.last_reviewed); rd.setAttribute('datetime', DATA.meta.last_reviewed); }
  }

  function setLang(code) {
    state.lang = LANGS.indexOf(code) !== -1 ? code : 'en';
    try { localStorage.setItem('ufs_portal_lang', state.lang); } catch (e) { /* ignore */ }
    applyStatic();
    if (DATA) renderAll();
  }

  /* ---------- events ---------- */
  function bind() {
    document.getElementById('language').addEventListener('change', function (e) { setLang(e.target.value); });
    document.getElementById('btn2023').addEventListener('click', function () { setYear('2023'); });
    document.getElementById('btn2027').addEventListener('click', function () { setYear('2027'); });

    var tabs = ['subject', 'party', 'compare'];
    tabs.forEach(function (k, i) {
      var tab = document.getElementById('tab-' + k);
      tab.addEventListener('click', function () { setMode(k); });
      tab.addEventListener('keydown', function (e) {
        var j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i + tabs.length - 1) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); setMode(tabs[j], true); }
      });
    });

    document.getElementById('categoryChips').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-cat]');
      if (!b) return;
      state.cat = b.getAttribute('data-cat');
      renderChips(); renderSubject(); syncUrl();
      var nb = document.querySelector('#categoryChips button[data-cat="' + state.cat + '"]');
      if (nb) nb.focus();
    });
    document.getElementById('orderSel').addEventListener('change', function (e) {
      state.order = e.target.value;
      renderAll();
    });
    document.getElementById('partySel').addEventListener('change', function (e) {
      state.party = e.target.value; renderParty(); syncUrl();
    });
    document.getElementById('cmpCat').addEventListener('change', function (e) {
      state.cmpCat = e.target.value; renderCompare(); syncUrl();
    });
    document.getElementById('cmpParties').addEventListener('change', function (e) {
      var id = e.target.value;
      var i = state.cmpParties.indexOf(id);
      if (e.target.checked && i === -1 && state.cmpParties.length < MAX_COMPARE) state.cmpParties.push(id);
      if (!e.target.checked && i !== -1) state.cmpParties.splice(i, 1);
      renderCompareControls(); renderCompare(); syncUrl();
      var again = document.querySelector('#cmpParties input[value="' + id + '"]');
      if (again) again.focus();
    });

    var mobileMenu = document.querySelector('.mobile-menu');
    document.addEventListener('click', function (event) {
      if (!mobileMenu.open) return;
      if (!mobileMenu.contains(event.target) || event.target.closest('.mini-nav a')) mobileMenu.open = false;
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !mobileMenu.open) return;
      mobileMenu.open = false;
      mobileMenu.querySelector('summary').focus({ preventScroll: true });
    });
  }

  /* ---------- boot ---------- */
  function index(list) { var o = {}; list.forEach(function (x) { o[x.id] = x; }); return o; }

  function load() {
    var files = ['taxonomy', 'parties', 'programmes', 'proposals'];
    return Promise.all(files.map(function (f) {
      return fetch('/data/' + f + '.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
        return r.json();
      });
    })).then(function (res) {
      var tax = res[0], parties = res[1], progs = res[2], props = res[3];
      DATA = {
        meta: parties.meta,
        taxonomy: tax.categories,
        parties: parties.parties,
        sources: progs.sources,
        proposals: props.proposals
      };
      DATA.taxonomyIndex = index(DATA.taxonomy);
      DATA.partyIndex = index(DATA.parties);
      DATA.sourceIndex = index(DATA.sources);
    });
  }

  var initial = 'en';
  try { initial = localStorage.getItem('ufs_portal_lang') || localStorage.getItem('ufs_lang') || (navigator.language || 'en').slice(0, 2).toLowerCase(); } catch (e) { /* ignore */ }
  state.lang = LANGS.indexOf(initial) !== -1 ? initial : 'en';
  applyStatic();
  bind();

  load().then(function () {
    state.cat = DATA.taxonomy[0].id;
    state.cmpCat = DATA.taxonomy[0].id;
    state.party = orderedParties()[0].id;
    readUrl();
    applyStatic();
    renderAll();
    setYear(state.year);
    setMode(state.mode);
  }).catch(function (err) {
    document.getElementById('subjectResults').innerHTML = '<p class="missing">' + esc(t('loadError')) + ' (' + esc(err.message) + ')</p>';
  });
})();
