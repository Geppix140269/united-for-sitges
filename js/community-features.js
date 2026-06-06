/* =====================================================================
   United for Sitges — community features
   Social share + volunteer/newsletter form handling. No dependencies.
   ===================================================================== */
(function () {
  var MESSAGES = {
    en: "Sitges belongs to everyone who calls it home. Join United for Sitges:",
    es: "Sitges pertenece a todos los que lo llaman hogar. Únete a United for Sitges:",
    ca: "Sitges pertany a tothom que l'anomena llar. Uneix-te a United for Sitges:"
  };
  var COPIED = { en: "Link copied!", es: "¡Enlace copiado!", ca: "Enllaç copiat!" };
  var SENT   = { en: "Thank you — we'll be in touch.", es: "Gracias — te contactaremos.", ca: "Gràcies — et contactarem." };

  function lang() {
    var l = (document.documentElement.lang || 'en').toLowerCase();
    return MESSAGES[l] ? l : 'en';
  }

  function shareUrl(net) {
    var url = window.location.origin + window.location.pathname;
    var u = encodeURIComponent(url);
    var t = encodeURIComponent(MESSAGES[lang()]);
    switch (net) {
      case 'facebook': return 'https://www.facebook.com/sharer/sharer.php?u=' + u;
      case 'x':        return 'https://twitter.com/intent/tweet?url=' + u + '&text=' + t;
      case 'whatsapp': return 'https://wa.me/?text=' + t + '%20' + u;
      case 'telegram': return 'https://t.me/share/url?url=' + u + '&text=' + t;
      case 'email':    return 'mailto:?subject=' + encodeURIComponent('United for Sitges') + '&body=' + t + '%20' + u;
    }
    return url;
  }

  function toast(msg) {
    var t = document.getElementById('ufsShareToast');
    if (!t) { t = document.createElement('div'); t.id = 'ufsShareToast'; t.className = 'ufs-share-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function wireShare() {
    document.querySelectorAll('.ufs-share-btn[data-net]').forEach(function (el) {
      var net = el.getAttribute('data-net');
      if (net === 'copy') {
        el.addEventListener('click', function () {
          var url = window.location.origin + window.location.pathname;
          var done = function () { toast(COPIED[lang()]); };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(done);
          } else {
            var ta = document.createElement('textarea'); ta.value = url;
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta); done();
          }
        });
      } else if (net === 'email') {
        el.addEventListener('click', function () { window.location.href = shareUrl(net); });
      } else {
        el.addEventListener('click', function () { window.open(shareUrl(net), '_blank', 'noopener,width=600,height=520'); });
      }
    });
  }

  function wireForms() {
    document.querySelectorAll('form.ufs-ajax').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var body = new URLSearchParams(new FormData(form)).toString();
        fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
          .then(function () {
            var note = document.createElement('p');
            note.textContent = SENT[lang()];
            note.style.cssText = 'color:var(--terra,#c0573b);font-weight:700;margin-top:14px;';
            form.replaceChildren(note);
          })
          .catch(function () { form.submit(); });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () { wireShare(); wireForms(); });
})();
