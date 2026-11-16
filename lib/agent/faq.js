// Deterministic matching against human-approved FAQ templates.
// No model is involved in matching or in producing the answer text.

import { normalise } from './classify/rules.js';
import { textFingerprint } from './crypto.js';

const MAX_EXTRA_CHARS = 40;          // the message may only add greetings/punctuation
const FILLER = /\b(hi|hello|hey|hola|bon dia|buenos dias|good morning|please|por favor|si us plau|thanks|thank you|gracias|gracies|merci)\b/g;

function core(text) {
  return normalise(text).replace(FILLER, ' ').replace(/[?.!,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Checks the approval record of a FAQ entry. Returns null when usable,
// otherwise a reason code.
export function faqIneligibility(faq, { now = new Date(), channelProvider, sourceMaxAgeDays = 180 } = {}) {
  if (!faq || !faq.active) return 'inactive';
  if (faq.origin !== 'human') return 'not_human_authored';
  if (!faq.approved_by || !faq.approved_at) return 'not_approved';
  if (!faq.answer_fingerprint || faq.answer_fingerprint !== textFingerprint(faq.approved_answer)) return 'fingerprint_mismatch';
  if (!faq.expires_at || new Date(faq.expires_at) <= now) return 'expired';
  if (faq.is_factual) {
    if (!faq.source_url || !faq.source_verified_at) return 'source_missing';
    const ageDays = (now - new Date(faq.source_verified_at)) / 86400000;
    if (ageDays > sourceMaxAgeDays) return 'source_stale';
  }
  if (channelProvider && !(faq.allowed_channels || []).includes(channelProvider)) return 'channel_not_allowed';
  return null;
}

// Returns { faq, phrase } for the single best exact match, or null.
// A match requires the message core to equal a match phrase core, or to
// contain it with at most MAX_EXTRA_CHARS of extra text. Ambiguous matches
// (two different FAQs) return null so a human decides.
export function matchFaq(text, faqs, { language } = {}) {
  const msg = core(text);
  if (!msg || msg.length > 300) return null;
  const hits = new Map();
  for (const faq of faqs || []) {
    if (language && language !== 'other' && faq.language !== language) continue;
    for (const phrase of faq.match_phrases || []) {
      const p = core(phrase);
      if (p.length < 6) continue;
      const exact = msg === p;
      const contained = !exact && msg.includes(p) && msg.length - p.length <= MAX_EXTRA_CHARS;
      if (exact || contained) {
        const prev = hits.get(faq.id);
        const score = exact ? 2 : 1;
        if (!prev || prev.score < score) hits.set(faq.id, { faq, phrase, score });
      }
    }
  }
  if (hits.size !== 1) return null;
  const [only] = hits.values();
  return { faq: only.faq, phrase: only.phrase, exact: only.score === 2 };
}

const DISCLOSURE = {
  en: 'Automated reply from United for Sitges. A person reviews questions we cannot answer automatically.',
  es: 'Respuesta automática de United for Sitges. Una persona revisa las preguntas que no podemos responder automáticamente.',
  ca: 'Resposta automàtica de United for Sitges. Una persona revisa les preguntes que no podem respondre automàticament.',
};

export function withDisclosure(answer, language) {
  return `${answer.trim()}\n\n(${DISCLOSURE[language] || DISCLOSURE.en})`;
}
