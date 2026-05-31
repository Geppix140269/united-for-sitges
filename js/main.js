/* United for Sitges — main.js */

/* =========================================================
   TRENCADÍS MARK — exact port of logo-mosaic.jsx algorithm
   Jittered 7×7 grid, seeded PRNG, clipped to disc, animated
   ========================================================= */
const SPECTRUM = ['#1F3864','#2E75B6','#119C94','#F4A81C','#F2604C','#D63E73','#6E4AA6','#C55A11','#BDD7EE','#F5E6D0'];
const GROUT = '#FBF8F2';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTiles(seed, cols, rows, jitter) {
  const rnd = mulberry32(seed);
  const cw = 100 / cols, ch = 100 / rows;
  const P = [];
  for (let i = 0; i <= cols; i++) {
    P[i] = [];
    for (let j = 0; j <= rows; j++) {
      const edge = i === 0 || j === 0 || i === cols || j === rows;
      const jx = edge ? 0 : (rnd() - 0.5) * jitter;
      const jy = edge ? 0 : (rnd() - 0.5) * jitter;
      P[i][j] = [i * cw + jx, j * ch + jy];
    }
  }
  const tiles = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const pts = [P[i][j], P[i+1][j], P[i+1][j+1], P[i][j+1]];
      tiles.push({ pts, r: rnd() });
    }
  }
  return tiles;
}

/* Stable tile set — built once from seed 7 (matches brand book) */
const TILES = buildTiles(7, 7, 7, 11);

let _markIdCounter = 0;
function buildMosaicMark(size, animate = true) {
  const id = 'mk' + (++_markIdCounter);
  const polys = TILES.map(t => {
    const fill = SPECTRUM[Math.floor(t.r * SPECTRUM.length) % SPECTRUM.length];
    const pts  = t.pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
    let anim = '';
    if (animate) {
      const dur   = (2.6 + t.r * 2.4).toFixed(2);
      const begin = (t.r * 1.8).toFixed(2);
      const lo    = Math.max(0.5, 0.6).toFixed(2);
      anim = `<animate attributeName="fill-opacity" values="1;${lo};1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
    }
    return `<polygon points="${pts}" fill="${fill}" stroke="${GROUT}" stroke-width="2.1" stroke-linejoin="round">${anim}</polygon>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="United for Sitges trencadís mark">
    <defs><clipPath id="${id}"><circle cx="50" cy="50" r="47"/></clipPath></defs>
    <g clip-path="url(#${id})">${polys}</g>
  </svg>`;
}

document.querySelectorAll('.mosaic-mark').forEach(el => {
  const size    = +(el.dataset.size || 40);
  const animate = el.dataset.animate !== 'false';
  el.innerHTML  = buildMosaicMark(size, animate);
  el.style.cssText += ';display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:0;';
});


/* =========================================================
   BRAND ICON SYSTEM — 24px grid, 2px stroke, rounded caps
   (from sections-applications.jsx)
   ========================================================= */
const ICONS = {
  vote:      'M5 12 h14 M12 5 l7 7 -7 7 M8 19 h-3 v-3',
  register:  'M5 4 h10 l4 4 v12 h-14 z M9 12 l2 2 4 -4',
  community: 'M7 11 a3 3 0 1 0 0 -6 M17 11 a3 3 0 1 0 0 -6 M3 19 a4 4 0 0 1 8 0 M13 19 a4 4 0 0 1 8 0',
  home:      'M4 11 l8 -7 8 7 M6 10 v9 h12 v-9',
  language:  'M4 5 h16 v11 h-9 l-4 4 v-4 h-3 z',
  calendar:  'M5 6 h14 v14 h-14 z M5 10 h14 M9 4 v4 M15 4 v4',
  heart:     'M12 20 C 4 14 4 7 8.5 6 C 11 5.5 12 8 12 8 C 12 8 13 5.5 15.5 6 C 20 7 20 14 12 20 Z',
  pin:       'M12 21 C 7 15 6 12 6 9 a6 6 0 0 1 12 0 c0 3 -1 6 -6 12 Z M12 9 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0',
  document:  'M6 3 h8 l4 4 v14 h-12 z M9 12 h6 M9 16 h6 M9 8 h3',
  check:     'M5 13 l4 5 L19 6',
  speech:    'M4 5 h16 v10 h-10 l-4 4 v-4 h-2 z',
  globe:     'M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18 M3 12 h18 M12 3 c4 4 4 14 0 18 M12 3 c-4 4 -4 14 0 18',
  house:     'M3 12 l9-9 9 9 M5 10 v9 h14 v-9',
  leaf:      'M2 22 l10-10 M14 8 C9 8 5 12 5 17 c5 0 9-4 9-9 Z',
  euro:      'M17 5 a8 8 0 1 0 0 14 M3 9 h10 M3 14 h10',
};

function icon(name, size, stroke) {
  size   = size   || 24;
  stroke = stroke || 'currentColor';
  const d = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
/* Render icon placeholders: <span data-icon="vote" data-icon-size="28"></span> */
document.querySelectorAll('[data-icon]').forEach(el => {
  const size   = +(el.dataset.iconSize || 24);
  const stroke = el.dataset.iconStroke || 'currentColor';
  el.innerHTML = icon(el.dataset.icon, size, stroke);
  el.style.display = 'inline-flex';
});


/* =========================================================
   TAGLINE CYCLER — 7 languages, 2400ms, brand book fadeUp
   ========================================================= */
const TAGLINES = [
  ['English',     'Your Town. Your Vote. Your Future.'],
  ['Español',     'Tu pueblo. Tu voto. Tu futuro.'],
  ['Català',      'El teu poble. El teu vot. El teu futur.'],
  ['Français',    'Votre ville. Votre vote. Votre avenir.'],
  ['Italiano',    'La tua città. Il tuo voto. Il tuo futuro.'],
  ['Deutsch',     'Deine Stadt. Deine Stimme. Deine Zukunft.'],
  ['Nederlands',  'Jouw stad. Jouw stem. Jouw toekomst.'],
];

const cyclerEl = document.getElementById('taglineCycler');
if (cyclerEl) {
  let idx = 0;
  function renderTagline() {
    const [, text] = TAGLINES[idx];
    cyclerEl.innerHTML = `<div class="tagline-frame">
      <div class="tagline-text">${text}</div>
    </div>`;
  }
  renderTagline();
  setInterval(() => {
    idx = (idx + 1) % TAGLINES.length;
    renderTagline();
  }, 2400);
}


/* =========================================================
   LANGUAGE SWITCHER
   ========================================================= */
let currentLang = 'en';
function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('[data-lang]').forEach(el => {
    el.classList.toggle('lang-active', el.dataset.lang === lang);
  });
  document.querySelectorAll('[data-lang-inline]').forEach(el => {
    el.classList.toggle('lang-active', el.dataset.langInline === lang);
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  document.documentElement.lang = lang;
}
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});
setLang('en');


/* =========================================================
   NAVBAR SCROLL STATE
   ========================================================= */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });


/* =========================================================
   ALERT BANNER
   ========================================================= */
const alertBanner = document.querySelector('.alert-banner');
if (alertBanner) {
  const closeBtn = alertBanner.querySelector('.close-banner');
  if (closeBtn) closeBtn.addEventListener('click', () => alertBanner.remove());
}


/* =========================================================
   MOBILE NAV
   ========================================================= */
const mobileNav = document.getElementById('mobileNav');
document.querySelector('.hamburger')?.addEventListener('click', () => {
  mobileNav.classList.add('open');
  document.body.style.overflow = 'hidden';
});
document.querySelector('.close-nav')?.addEventListener('click', closeMobileNav);
mobileNav?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMobileNav));
function closeMobileNav() {
  mobileNav.classList.remove('open');
  document.body.style.overflow = '';
}


/* =========================================================
   DONATE AMOUNT BUTTONS
   ========================================================= */
const amountBtns  = document.querySelectorAll('.amount-btn');
const customInput = document.getElementById('customAmount');
amountBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    amountBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (customInput) customInput.value = '';
  });
});
if (customInput) {
  customInput.addEventListener('input', () => {
    amountBtns.forEach(b => b.classList.remove('active'));
  });
}


/* =========================================================
   SUPPORT FORM
   ========================================================= */
const supportForm = document.getElementById('supportForm');
if (supportForm) {
  supportForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = supportForm.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = '…';
    try {
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(supportForm)).toString(),
      });
      if (res.ok) {
        supportForm.style.display = 'none';
        document.getElementById('supportSuccess').style.display = 'block';
      } else throw new Error();
    } catch {
      showToast('Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Register Support';
    }
  });
}


/* =========================================================
   DONATE FORM
   ========================================================= */
const donateForm = document.getElementById('donateForm');
if (donateForm) {
  donateForm.addEventListener('submit', async e => {
    e.preventDefault();
    const activeBtn = document.querySelector('.amount-btn.active');
    const amount = activeBtn ? activeBtn.dataset.amount : customInput?.value;
    if (!amount || parseFloat(amount) <= 0) {
      showToast('Please select or enter a donation amount.'); return;
    }
    const btn = donateForm.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = '…';
    const body = new URLSearchParams(new FormData(donateForm));
    body.set('amount', amount);
    try {
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (res.ok) {
        donateForm.style.display = 'none';
        document.getElementById('donateSuccess').style.display = 'block';
      } else throw new Error();
    } catch {
      showToast('Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Donate Now';
    }
  });
}


/* =========================================================
   TOAST
   ========================================================= */
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast'; toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}


/* =========================================================
   ANIMATED COUNTERS
   ========================================================= */
function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  const steps  = 1800 / 16;
  const inc    = target / steps;
  let cur = 0;
  const t = setInterval(() => {
    cur += inc;
    if (cur >= target) { el.textContent = target.toLocaleString(); clearInterval(t); }
    else el.textContent = Math.floor(cur).toLocaleString();
  }, 16);
}
const counters = document.querySelectorAll('[data-target]');
if (counters.length) {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { animateCounter(e.target); io.unobserve(e.target); } });
  }, { threshold: 0.5 });
  counters.forEach(c => io.observe(c));
}


/* =========================================================
   NAV ACTIVE HIGHLIGHT
   ========================================================= */
const sections  = document.querySelectorAll('section[id]');
const navLinks  = document.querySelectorAll('.nav-links a[href^="#"]');
window.addEventListener('scroll', () => {
  const pos = window.scrollY + 120;
  sections.forEach(s => {
    if (s.offsetTop <= pos && s.offsetTop + s.offsetHeight > pos) {
      navLinks.forEach(a => a.classList.toggle('current', a.getAttribute('href') === '#' + s.id));
    }
  });
}, { passive: true });


/* =========================================================
   MOSAIC BAND GENERATOR
   ========================================================= */
document.querySelectorAll('.mosaic-band').forEach(band => {
  const count = parseInt(band.dataset.count || '20', 10);
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.style.background = SPECTRUM[i % SPECTRUM.length];
    band.appendChild(s);
  }
});
