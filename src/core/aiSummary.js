import Anthropic from '@anthropic-ai/sdk';

// AI-assisted filing summaries. Everything returned here is AI-GENERATED ANALYSIS: it is stored and
// shown apart from the filing facts, carries the model that produced it, and every summary sentence
// keeps the exact passages it was drawn from (Messages API citations on the filing document), so a
// reader can check each claim against the filing. Summaries are made only on request (they cost API
// usage) and stored, so the same filing is never billed twice.
//
// Credentials: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). Without one the feature reports NOT CONFIGURED.

export const SUMMARY_MODEL = 'claude-opus-5';
export const MAX_FILING_CHARS = 1_500_000; // ~375k tokens; longer filings are refused, never silently cut

export function aiConfigured(env = process.env) { return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN); }

// SEC HTML -> readable text (scripts, styles and XBRL header blocks dropped; entities decoded).
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|ix:header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const INSTRUCTIONS = `You summarize one SEC filing for a trader's research desk. Use only the attached filing.
Write these sections, each starting with its heading on its own line:
WHAT HAPPENED - two to four sentences.
NUMBERS - the key figures stated in the filing (results, guidance, amounts, share counts), or "None stated".
PEOPLE AND DEALS - executive changes, agreements, acquisitions, financing, or "None stated".
RISKS AND CAVEATS - risks or uncertainties the filing itself states, or "None stated".
Rules: state only what the filing says, with its own figures and dates; do not predict prices, give advice, or infer intent; if something is unclear in the filing, say it is unclear.`;

// client: an Anthropic instance (injectable for tests). facts: the filing facts (form, company, ...).
export async function summarizeFiling({ text, facts, client = new Anthropic(), model = SUMMARY_MODEL }) {
  const body = String(text || '');
  if (body.length < 200) throw new Error('Filing text is too short to summarize (was the document empty?)');
  if (body.length > MAX_FILING_CHARS) throw Object.assign(new Error(`Filing is ${body.length.toLocaleString()} characters, above the ${MAX_FILING_CHARS.toLocaleString()} limit; it is not summarized rather than cut short`), { code: 'TOO_LONG' });
  const title = `${facts?.form || 'Filing'} - ${facts?.company || ''} (${facts?.accession || ''})`.trim();
  let response;
  try {
    response = await client.beta.messages.create({
      model, max_tokens: 16000, output_config: { effort: 'medium' },
      // Server-side refusal fallback: if the model declines, the API reruns on a fallback model.
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: body }, title, citations: { enabled: true } },
        { type: 'text', text: 'Summarize this filing.' },
      ] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('Anthropic API key rejected'), { code: 'AUTH_ERROR' });
    if (e instanceof Anthropic.RateLimitError) throw Object.assign(new Error('Anthropic API rate limited; try again shortly'), { code: 'RATE_LIMITED' });
    if (e instanceof Anthropic.APIError) throw Object.assign(new Error(`Anthropic API error ${e.status}: ${String(e.message).slice(0, 200)}`), { code: 'API_ERROR' });
    throw e;
  }
  if (response.stop_reason === 'refusal') return { status: 'REFUSED', model: response.model, category: response.stop_details?.category ?? null, explanation: response.stop_details?.explanation ?? null, blocks: [] };
  // Text blocks, each with the filing passages it cites (cited_text + character range in the text).
  const blocks = (response.content || []).filter(b => b.type === 'text').map(b => ({ text: b.text, citations: (b.citations || []).filter(c => c.type === 'char_location').map(c => ({ quote: c.cited_text, start: c.start_char_index, end: c.end_char_index })) }));
  return { status: response.stop_reason === 'max_tokens' ? 'TRUNCATED_OUTPUT' : 'OK', model: response.model, requestedModel: model, blocks,
    // Share of claim sentences backed by a citation (headings and "None stated" lines are not claims).
    citedShare: (() => { const claims = blocks.filter(b => { const t = b.text.trim(); return t.length >= 25 && t !== t.toUpperCase(); }); return claims.length ? claims.filter(b => b.citations.length).length / claims.length : null; })(),
    usage: { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null } };
}
