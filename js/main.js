/* United for Sitges — main.js */

/* ---- Mosaic Mark SVG generator ---- */
function buildMosaicMark(size) {
  const COLORS = ['#2E75B6','#119C94','#F4A81C','#F2604C','#D63E73','#6E4AA6','#C55A11','#BDD7EE','#1F3864'];
  const cx = size / 2, cy = size / 2;
  const R = size * 0.46, r = size * 0.14;
  const n = COLORS.length, step = 360 / n, gap = 2.5;
  const rad = d => d * Math.PI / 180;
  const pt = (radius, deg) => [cx + radius * Math.cos(rad(deg)), cy + radius * Math.sin(rad(deg))];
  const f = v => v.toFixed(2);

  const paths = COLORS.map((color, i) => {
    const a1 = -90 + i * step + gap / 2;
    const a2 = -90 + (i + 1) * step - gap / 2;
    const [x1i, y1i] = pt(r, a1);
    const [x1o, y1o] = pt(R, a1);
    const [x2o, y2o] = pt(R, a2);
    const [x2i, y2i] = pt(r, a2);
    return `<path d="M${f(x1i)},${f(y1i)} L${f(x1o)},${f(y1o)} A${f(R)},${f(R)} 0 0,1 ${f(x2o)},${f(y2o)} L${f(x2i)},${f(y2i)} A${f(r)},${f(r)} 0 0,0 ${f(x1i)},${f(y1i)}Z" fill="${color}"/>`;
  }).join('');

  const dotR = (r * 0.7).toFixed(2);
  const dot = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${dotR}" fill="#1F3864"/>`;
  const ring = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R + 1)}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;

  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="United for Sitges mosaic mark">${paths}${dot}${ring}</svg>`;
}

document.querySelectorAll('.mosaic-mark').forEach(el => {
  const size = +(el.dataset.size || 40);
  el.innerHTML = buildMosaicMark(size);
  el.style.display = 'inline-flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.flexShrink = '0';
});

/* ---- Language switcher ---- */
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

/* ---- Navbar scroll state ---- */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

/* ---- Alert banner close ---- */
const alertBanner = document.querySelector('.alert-banner');
if (alertBanner) {
  const closeBtn = alertBanner.querySelector('.close-banner');
  if (closeBtn) closeBtn.addEventListener('click', () => alertBanner.remove());
}

/* ---- Mobile nav ---- */
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

/* ---- Donate amount buttons ---- */
const amountBtns = document.querySelectorAll('.amount-btn');
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

/* ---- Support form ---- */
const supportForm = document.getElementById('supportForm');
if (supportForm) {
  supportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = supportForm.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = '...';

    const body = new URLSearchParams(new FormData(supportForm));
    try {
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (res.ok) {
        supportForm.style.display = 'none';
        document.getElementById('supportSuccess').style.display = 'block';
      } else {
        throw new Error('Network error');
      }
    } catch {
      showToast('Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Register Support';
    }
  });
}

/* ---- Donate form ---- */
const donateForm = document.getElementById('donateForm');
if (donateForm) {
  donateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const activeBtn = document.querySelector('.amount-btn.active');
    const customVal = customInput?.value;
    const amount = activeBtn ? activeBtn.dataset.amount : customVal;
    if (!amount || parseFloat(amount) <= 0) {
      showToast('Please select or enter a donation amount.');
      return;
    }
    const btn = donateForm.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = '...';

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
      } else {
        throw new Error();
      }
    } catch {
      showToast('Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Donate Now';
    }
  });
}

/* ---- Toast ---- */
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

/* ---- Animated counters ---- */
function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  const duration = 1800;
  const step = 16;
  const steps = duration / step;
  const increment = target / steps;
  let current = 0;
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      el.textContent = target.toLocaleString();
      clearInterval(timer);
    } else {
      el.textContent = Math.floor(current).toLocaleString();
    }
  }, step);
}

const counters = document.querySelectorAll('[data-target]');
if (counters.length) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  counters.forEach(c => io.observe(c));
}

/* ---- Smooth nav highlight ---- */
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
window.addEventListener('scroll', () => {
  const scrollPos = window.scrollY + 120;
  sections.forEach(sec => {
    if (sec.offsetTop <= scrollPos && sec.offsetTop + sec.offsetHeight > scrollPos) {
      navLinks.forEach(a => {
        a.classList.toggle('current', a.getAttribute('href') === '#' + sec.id);
      });
    }
  });
}, { passive: true });

/* ---- Mosaic band generator ---- */
const spectrum = ['#1F3864','#2E75B6','#119C94','#F4A81C','#F2604C','#D63E73','#6E4AA6','#C55A11','#BDD7EE','#F5E6D0'];
document.querySelectorAll('.mosaic-band').forEach(band => {
  const count = parseInt(band.dataset.count || '20', 10);
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.style.background = spectrum[i % spectrum.length];
    band.appendChild(s);
  }
});
