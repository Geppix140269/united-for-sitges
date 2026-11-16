// Deterministic content quality gates for editorial publishing.
// A hard failure blocks; a review failure sends the slot to NEEDS_REVIEW.
// Nothing here can be relaxed to meet a posting quota.

import { getPartyTerms, normalise, ruleClassify, detectLanguage } from '../classify/rules.js';
import { excerptSupported } from './sources.js';

const ADVOCACY = /\b(vote for|vote against|don'?t vote|support (the )?(party|candidate)|elect (him|her|them)|should win|best candidate|worst candidate|vota a|vota per|votad|no votes|no voteu|apoya a|dona suport a|the only (party|choice)|better than (the )?(other|rival))\b/;
const COMPARATIVE = /\b(unlike|compared (to|with)|better than|worse than|more than|less than|a diferencia de|millor que|pitjor que|mejor que|peor que)\b/;
const FABRICATED_COMMUNITY = /\b(residents (told|tell) us|many of you (said|told)|people (told|tell) us|we (interviewed|spoke (to|with)|attended|visited|met with)|i (visited|attended|met|spoke)|our readers say|neighbours say|vecinos (nos )?dicen|veins ens diuen)\b/;
const HUMAN_CLAIM = /\b(i am|i'm) (a )?(human|person|resident|local|volunteer)\b|\bas a (resident|local|sitges resident)\b|\b(soy|soc) (vecino|vei|vecina|veina|residente|resident)\b/;
const ELECTORAL_SENSITIVE = /\b(deadline|eligible|eligibility|must register|registration closes|cutoff|plazo|termini|requisito|requisit|puedes votar|pots votar|you can vote|you cannot vote|derecho a voto|dret a vot)\b/;
const DATE_RE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2} (de )?(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|gener|febrer|marc|abril|maig|juny|juliol|agost|setembre|octubre|novembre|desembre)\b/;
const NUMBER_RE = /\b\d+(?:[.,]\d+)*\s?%?/g;

function urlsIn(text) {
  return String(text).match(/https?:\/\/[^\s)\]]+/gi) || [];
}

export function shingles(text, n = 3) {
  const w = normalise(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function similarity(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function partyMentions(text) {
  const n = normalise(text);
  return getPartyTerms().filter((t) => t.length >= 3 && new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(n));
}

// content: model output (validated shape). context: { topic, sources: [{slug,url,text}], recent: [{text, topic_key}], allowedHosts }
export function runContentGates(content, context) {
  const gates = [];
  const add = (name, result, severity, detail) => gates.push({ name, result, severity, detail: detail ?? null });
  const allText = [content.title, content.body, content.discussion_question, content.facebook_text, content.instagram_caption, content.es_summary, content.ca_summary]
    .filter(Boolean).join('\n');
  const n = normalise(allText);

  // 1. Factual verification
  const sourceBySlug = new Map((context.sources || []).map((s) => [s.slug, s]));
  if (context.topic.factual) {
    const claims = content.claims || [];
    if (!claims.length) add('factual_claims_present', 'fail', 'hard', 'factual topic without claims');
    const unsupported = claims.filter((c) => !sourceBySlug.has(c.source_slug) || !excerptSupported(c.supporting_excerpt, sourceBySlug.get(c.source_slug).text));
    add('claims_supported_by_sources', unsupported.length ? 'fail' : 'pass', 'hard', unsupported.map((c) => c.text.slice(0, 80)));
    const excerptText = claims.map((c) => c.supporting_excerpt).join(' ');
    const numbers = (`${content.body} ${content.facebook_text} ${content.instagram_caption}`.match(NUMBER_RE) || []).map((x) => x.trim()).filter((x) => x.length > 0);
    const unsupportedNumbers = numbers.filter((num) => !excerptText.includes(num.replace(/\s?%$/, '')));
    add('numbers_supported', unsupportedNumbers.length ? 'fail' : 'pass', 'hard', unsupportedNumbers);
  } else {
    const claims = content.claims || [];
    add('discussion_has_no_factual_claims', claims.length ? 'fail' : 'pass', 'hard');
    const numbers = (`${content.body} ${content.facebook_text}`.match(/\b\d{2,}\b/g) || []);
    add('discussion_no_statistics', numbers.length ? 'fail' : 'pass', 'hard', numbers);
  }

  // 2. Political neutrality
  add('no_political_advocacy', ADVOCACY.test(n) ? 'fail' : 'pass', 'hard');
  const parties = partyMentions(allText);
  add('no_party_or_candidate_mentions', parties.length ? 'fail' : 'pass', 'hard', parties);
  if (parties.length || /\b(candidate|candidat|candidato|mayor|alcalde|alcaldessa)\b/.test(n)) {
    add('no_comparative_political_claims', COMPARATIVE.test(n) ? 'fail' : 'pass', 'hard');
  }

  // 3. Sensitive electoral claims -> human review
  if (context.topic.category === 'electoral_resources' || context.topic.sensitive_electoral) {
    const sensitive = ELECTORAL_SENSITIVE.test(n) || DATE_RE.test(n);
    add('electoral_claims_reviewed', sensitive ? 'fail' : 'pass', 'review');
  }

  // 4. Integrity
  add('no_fabricated_community_voices', FABRICATED_COMMUNITY.test(n) ? 'fail' : 'pass', 'hard');
  add('no_human_identity_claims', HUMAN_CLAIM.test(n) ? 'fail' : 'pass', 'hard');
  const pii = ruleClassify(allText).signals.find((s) => s.code === 'personal_information');
  const piiKinds = (pii?.detail || []).filter((k) => !(k === 'email' && /hello@giuseppefunaro\.com/i.test(allText)));
  add('no_personal_data', piiKinds.length ? 'fail' : 'pass', 'hard', piiKinds);
  add('no_threat_or_harassment', ruleClassify(allText).signals.some((s) => ['threat', 'personal_attack'].includes(s.code)) ? 'fail' : 'pass', 'hard');

  // 5. Links
  const allowedUrls = new Set((context.sources || []).map((s) => s.url));
  const badUrls = urlsIn(allText).filter((u) => {
    if (allowedUrls.has(u)) return false;
    try { return !context.allowedHosts.includes(new URL(u).host); } catch { return true; }
  });
  add('links_from_registry', badUrls.length ? 'fail' : 'pass', 'hard', badUrls);

  // 6. Language
  const lang = detectLanguage(content.body);
  add('primary_language_english', lang === 'en' ? 'pass' : 'fail', 'review', lang);

  // 7. Duplication
  const window = context.recent || [];
  const sameTopic = window.some((r) => r.topic_key === context.topic.key);
  const maxSim = window.reduce((m, r) => Math.max(m, similarity(content.body, r.text)), 0);
  const threshold = Number(context.similarityThreshold) || 0.6;
  add('not_duplicate', sameTopic || maxSim >= threshold ? 'fail' : 'pass', 'hard', { sameTopic, maxSimilarity: Number(maxSim.toFixed(3)) });

  // 8. Platform requirements
  const hashtags = (content.instagram_caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  add('instagram_caption_limits', content.instagram_caption.length <= 2200 && hashtags <= 30 ? 'pass' : 'fail', 'hard');
  add('facebook_text_limits', content.facebook_text.length <= 3000 ? 'pass' : 'fail', 'hard');

  const hard = gates.some((g) => g.severity === 'hard' && g.result === 'fail');
  const review = gates.some((g) => g.severity === 'review' && g.result === 'fail');
  return {
    gates,
    factual: context.topic.factual ? (gates.find((g) => g.name === 'claims_supported_by_sources')?.result === 'pass' && gates.find((g) => g.name === 'numbers_supported')?.result === 'pass' ? 'passed' : 'failed') : 'not_required',
    neutrality: gates.filter((g) => ['no_political_advocacy', 'no_party_or_candidate_mentions', 'no_comparative_political_claims'].includes(g.name)).every((g) => g.result === 'pass') ? 'passed' : 'failed',
    duplication: gates.find((g) => g.name === 'not_duplicate').result === 'pass' ? 'unique' : 'duplicate',
    publishability: hard ? 'blocked' : review ? 'needs_review' : 'publishable',
  };
}
