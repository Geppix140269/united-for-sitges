// Platform adaptation of validated canonical content. Deterministic: it only
// rearranges already-validated text, so nothing new is introduced here.

import { cardUrlFor } from './media.js';

const AI_NOTE = {
  facebook_page: 'Prepared with AI-assisted editorial tools and checked against the sources linked.',
  instagram: 'Prepared with AI-assisted editorial tools.',
  mock: 'Prepared with AI-assisted editorial tools.',
};

export function adaptForChannel(content, channel, { topic } = {}) {
  const pref = channel.language_preference || 'en';
  const extras = [];
  if (pref.includes('es') && content.es_summary) extras.push(`ES: ${content.es_summary}`);
  if (pref.includes('ca') && content.ca_summary) extras.push(`CA: ${content.ca_summary}`);
  const sourceLines = (content.claims || []).length
    ? [...new Set((content.source_urls || []))].map((u) => `Source: ${u}`)
    : [];

  if (channel.provider === 'instagram') {
    const caption = [content.instagram_caption, ...extras, AI_NOTE.instagram].filter(Boolean).join('\n\n').slice(0, 2200);
    return { text: caption, link: null, mediaUrl: cardUrlFor(topic?.category || content.category) };
  }
  const note = sourceLines.length ? (AI_NOTE[channel.provider] || AI_NOTE.mock) : AI_NOTE.mock;
  const text = [content.facebook_text, ...extras, ...sourceLines, note].filter(Boolean).join('\n\n');
  return { text, link: content.source_urls?.[0] || null, mediaUrl: null };
}
