// Deterministic pre-classification. Runs before (and independently of) any
// model call. Rules can only ADD risk; nothing downstream may lower it.

import partyData from '../../../data/parties.json' with { type: 'json' };

export function normalise(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^a-z0-9@+'.\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(list) {
  return list.map((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i'));
}

// --- Party and institution names (from the site's own dataset) -------------
let partyTerms = null;
export function getPartyTerms() {
  if (partyTerms) return partyTerms;
  const generic = ['psc', 'erc', 'junts', 'pp', 'vox', 'ciutadans', 'cs', 'comuns', 'podem', 'guanyem', 'cup', 'psoe', 'sumar', 'podemos'];
  let fromData = [];
  try {
    const raw = partyData;
    for (const p of raw.parties || []) {
      for (const n of [p.short_name, p.name_2023_official, p.abbreviation_2023]) {
        if (typeof n === 'string' && n.trim().length >= 2) fromData.push(normalise(n));
      }
    }
  } catch { fromData = []; }
  partyTerms = [...new Set([...generic, ...fromData])].filter((t) => t.length >= 2);
  return partyTerms;
}

const ELECTORAL = words([
  'vote', 'votes', 'voting', 'voter', 'voters', 'ballot', 'election', 'elections', 'electoral', 'register to vote', 'voter registration',
  'electoral roll', 'census', 'eligible', 'eligibility', 'deadline', 'cere', 'ine', 'padron', 'padro', 'empadronamiento', 'empadronament',
  'votar', 'voto', 'vot', 'elecciones', 'eleccions', 'censo', 'cens', 'plazo', 'termini', 'inscripcion', 'inscripcio',
  'puedo votar', 'puc votar', 'can i vote', 'nationality', 'nacionalidad', 'nacionalitat', 'residency', 'manifestacion de voluntad',
]);

const POLITICAL = words([
  'party', 'parties', 'candidate', 'candidates', 'candidacy', 'mayor', 'councillor', 'councilor', 'council member', 'left wing', 'right wing',
  'partido', 'partit', 'candidato', 'candidata', 'candidat', 'alcalde', 'alcaldesa', 'alcaldessa', 'regidor', 'regidora', 'concejal', 'concejala',
  'government', 'gobierno', 'govern', 'opposition', 'oposicion', 'oposicio', 'campaign', 'campana', 'campanya',
]);

const ALLEGATION = words([
  'corrupt', 'corruption', 'fraud', 'bribe', 'bribes', 'stole', 'stealing', 'thief', 'criminal', 'crook', 'embezzle', 'embezzlement',
  'corrupto', 'corrupta', 'corrupcion', 'corrupcio', 'fraude', 'frau', 'soborno', 'suborn', 'ladron', 'lladre', 'robo', 'robatori', 'delincuente', 'delinquent',
]);

const THREAT = [
  /\b(i|we)('ll| will| are going to| gonna) (kill|hurt|beat|shoot|stab|burn|find) (you|him|her|them)\b/,
  /\b(kill|shoot|stab|bomb) (you|him|her|them|the mayor|everyone)\b/,
  /\byou (will|are going to|gonna) (die|pay for this)\b/,
  /\b(te|os|le|les) (voy|vamos) a (matar|pegar|quemar|reventar)\b/,
  /\b(et|us|el|la|els) (matare|matarem|cremare|rebentare)\b/,
  /\b(bomba|bomb threat|amenaza de bomba)\b/,
  /\b(matar|mataros|matarte|cremar-te|matar-te)\b/,
];

const INSULT = words([
  'idiot', 'idiots', 'stupid', 'moron', 'imbecile', 'scum', 'retard', 'retarded', 'loser', 'pathetic', 'dickhead', 'asshole', 'bitch', 'bastard',
  'idiota', 'imbecil', 'estupido', 'estupida', 'gilipollas', 'subnormal', 'cabron', 'cabrona', 'puta', 'mierda', 'capullo', 'escoria',
  'imbecil', 'estupid', 'burro', 'fill de puta', 'malparit', 'tonto', 'tonta', 'garrulo',
]);

const PERSON_TARGET = /\b(you|you're|youre|ur|eres|sois|ets|sou|tu|vosotros|vosaltres|he is|she is|he's|she's|es un|es una|is a|are a)\b/;

const SPAM = [
  /\b(crypto|bitcoin|forex|investment opportunity|earn \$?\d+|make money fast|giveaway|casino|betting|onlyfans|viagra|loan offer)\b/,
  /\b(dm me|message me on whatsapp|whatsapp me|telegram me|click (the )?link in (my )?bio|follow me)\b/,
  /\b(gana dinero|inversion segura|prestamo rapido|escribeme por whatsapp)\b/,
];

const INJECTION = [
  /ignore (all |any |the )?(previous |prior |above |earlier )?(instructions|rules|prompts?)/,
  /disregard (all |the )?(previous |prior )?(instructions|rules)/,
  /(reveal|show|print|repeat|leak) (me )?(your|the) (system )?(prompt|instructions|rules|configuration)/,
  /\bsystem prompt\b/, /\byou are now\b/, /\bdeveloper mode\b/, /\bjailbreak\b/, /\bact as (an?|the) /,
  /\bnew instructions?\b/, /<\/?(system|assistant|instructions?)>/, /^\s*(system|assistant)\s*:/m,
  /ignora (todas )?(las )?instrucciones/, /olvida (todas )?(las |tus )?instrucciones/, /ignora (totes )?(les )?instruccions/,
  /\bpublish (this|the following)\b/, /\bapprove (this|yourself)\b/, /\bauto[- ]?approve\b/,
];

// PII patterns are evaluated on the ORIGINAL text (case-insensitive).
const PII = [
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { kind: 'phone', re: /(?:\+?34[\s.-]?)?(?:[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|[6789]\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2})\b/ },
  { kind: 'intl_phone', re: /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/ },
  { kind: 'dni_nie', re: /\b(?:[XYZ][-\s]?\d{7}|\d{8})[-\s]?[A-HJ-NP-TV-Z]\b/i },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]{4}){4,7}\b/i },
  { kind: 'passport_or_id_words', re: /\b(passport number|numero de pasaporte|dni number|my nie is|mi nie es|el meu nie es)\b/i },
  { kind: 'street_address', re: /\b(calle|carrer|c\/|avenida|avinguda|av\.)\s+[a-zÀ-ſ .'-]{2,40}\s*,?\s*\d{1,4}\b/i },
];

function anyMatch(list, text) {
  return list.some((re) => re.test(text));
}

function containsTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

const LANG_HINTS = {
  en: ['the', 'and', 'is', 'are', 'what', 'how', 'where', 'can', 'you', 'i', 'to', 'of', 'this', 'please', 'thanks'],
  es: ['el', 'la', 'los', 'las', 'que', 'es', 'como', 'donde', 'puedo', 'para', 'por', 'gracias', 'hola', 'esta', 'una', 'y'],
  ca: ['el', 'la', 'els', 'les', 'que', 'es', 'com', 'on', 'puc', 'per', 'gracies', 'hola', 'aquesta', 'una', 'i', 'amb', 'molt', 'perque'],
};

export function detectLanguage(text) {
  const tokens = normalise(text).split(' ');
  const score = {};
  for (const [lang, hints] of Object.entries(LANG_HINTS)) score[lang] = tokens.filter((t) => hints.includes(t)).length;
  // Distinguishing tokens.
  if (/\b(amb|aquest|aquesta|molt|gracies|perque|puc|meu|nostre|vosaltres|ajuntament)\b/.test(normalise(text))) score.ca += 3;
  if (/\b(donde|puedo|gracias|nuestro|vosotros|ayuntamiento|tambien|muy)\b/.test(normalise(text))) score.es += 3;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] === 0) return 'other';
  return best[0];
}

// Returns signals plus the most severe deterministic category/risk.
export function ruleClassify(text) {
  const raw = String(text ?? '');
  const n = normalise(raw);
  const signals = [];
  const pii = PII.filter((p) => p.re.test(raw)).map((p) => p.kind);
  if (pii.length) signals.push({ code: 'personal_information', detail: pii });
  if (anyMatch(THREAT, n)) signals.push({ code: 'threat' });
  const insult = anyMatch(INSULT, n);
  if (insult && PERSON_TARGET.test(n)) signals.push({ code: 'personal_attack' });
  else if (insult) signals.push({ code: 'hostile_language' });
  if (anyMatch(INJECTION, n) || anyMatch(INJECTION, raw.toLowerCase())) signals.push({ code: 'prompt_injection' });
  if (anyMatch(ELECTORAL, n)) signals.push({ code: 'electoral' });
  const parties = getPartyTerms().filter((t) => containsTerm(n, t));
  if (parties.length || anyMatch(POLITICAL, n)) signals.push({ code: 'political' });
  if (anyMatch(ALLEGATION, n)) signals.push({ code: 'allegation' });
  const urlCount = (raw.match(/https?:\/\/|www\./gi) || []).length;
  if (anyMatch(SPAM, n) || urlCount >= 3) signals.push({ code: 'spam' });
  if (urlCount >= 1) signals.push({ code: 'contains_link', detail: urlCount });

  const has = (c) => signals.some((s) => s.code === c);
  let category = null;
  let risk = 'low';
  if (has('threat')) { category = 'threat_or_unlawful'; risk = 'critical'; }
  else if (has('personal_information')) { category = 'personal_information'; risk = 'high'; }
  else if (has('personal_attack')) { category = 'harassment'; risk = 'high'; }
  else if (has('electoral')) { category = 'electoral_procedure'; risk = 'medium'; }
  else if (has('political')) { category = 'political_discussion'; risk = 'medium'; }
  else if (has('spam')) { category = 'spam'; risk = 'medium'; }
  if (has('allegation')) risk = maxRisk(risk, 'high');
  if (has('prompt_injection') || has('hostile_language')) risk = maxRisk(risk, 'medium');

  return { category, risk, signals, language: detectLanguage(raw), blocksAutomation: signals.some((s) => s.code !== 'contains_link') };
}

const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
export function maxRisk(a, b) {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))];
}

// Most severe first. A combined decision always takes the more severe one.
export const CATEGORY_SEVERITY = [
  'threat_or_unlawful', 'personal_information', 'harassment', 'electoral_procedure', 'political_discussion',
  'complaint', 'spam', 'civic_information', 'unclear', 'community_feedback', 'approved_faq', 'platform_info',
];
export function moreSevere(a, b) {
  if (!a) return b;
  if (!b) return a;
  return CATEGORY_SEVERITY.indexOf(a) <= CATEGORY_SEVERITY.indexOf(b) ? a : b;
}
