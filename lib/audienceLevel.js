export const AUDIENCE_LEVELS = {
  developer: 'developer',
  balanced: 'balanced',
  executive: 'executive',
}

export const AUDIENCE_LABELS = {
  developer: 'Developer / technical buyer',
  balanced: 'Mixed room (default)',
  executive: 'CEO / non-technical manager',
}

const EXECUTIVE_REPLACEMENTS = [
  {
    pattern: /Integrate over REST APIs and webhooks into your LOS, CRM, accounting system, and SharePoint — reads and writes happen in the background, no rip-and-replace\.?/gi,
    replacement: 'We connect to your LOS, CRM, accounting, and SharePoint in the background — your team keeps the same workflows, no big system swap.',
  },
  {
    pattern: /Run OCR on each document, extract the key fields, then a rules engine cross-checks appraisal value, budget line, and borrower financials — mismatches land in a review queue before anyone signs off\.?/gi,
    replacement: 'We read each document automatically and flag when appraisal, budget, and borrower numbers disagree — anything off goes to a review queue before sign-off.',
  },
  {
    pattern: /Store files in S3, index metadata in Postgres, serve through a CDN, and cache hot reads in Redis — that scales to millions of documents without slowing search\.?/gi,
    replacement: 'Cloud file storage with a fast search index and caching — it scales to millions of documents without slowing the team down.',
  },
  {
    pattern: /No — your loan documents never train public models\. We use enterprise API agreements with zero retention on your payloads, and contract language that your data stays in your tenant\.?/gi,
    replacement: 'No — your documents are never used to train public AI. We use enterprise agreements with zero data retention, and the contract states your data stays yours.',
  },
  {
    pattern: /Extract fields with OCR first, generate summaries only from those extracted values, and run a rules engine cross-check against source documents — anything that fails validation goes to a human review queue\.?/gi,
    replacement: 'Summaries pull only from extracted document fields, then automatic checks compare them to the originals — anything that fails goes to a person for review.',
  },
  {
    pattern: /Store appraisals and financials in S3, index deal metadata in Postgres, expose a REST API for your LOS and SharePoint, and run OCR plus a rules engine on draw requests and insurance certificates\.?/gi,
    replacement: 'Store deal documents securely, index the key fields for search, connect to your LOS and SharePoint, and auto-check draw requests and insurance certificates against your rules.',
  },
]

function softenJargon(text = '') {
  return text
    .replace(/\bREST APIs?\b/gi, 'standard APIs')
    .replace(/\bwebhooks?\b/gi, 'real-time updates')
    .replace(/\bidempotent sync\b/gi, 'safe re-sync')
    .replace(/\bPostgres\b/gi, 'a database')
    .replace(/\bRedis cache\b/gi, 'caching')
    .replace(/\bRedis\b/gi, 'caching')
    .replace(/\bS3 object storage\b/gi, 'cloud file storage')
    .replace(/\bS3\b/gi, 'cloud storage')
    .replace(/\bCDN\b/gi, 'a content delivery network')
    .replace(/\bOCR\b/gi, 'document reading')
    .replace(/\brules engine\b/gi, 'automated checks')
    .replace(/\bSFTP\b/gi, 'secure file transfer')
    .replace(/\bzero retention on your payloads\b/gi, 'zero data retention')
}

export function normalizeAudienceLevel(value = '') {
  const key = String(value || '').trim().toLowerCase()
  if (key === AUDIENCE_LEVELS.developer || key === AUDIENCE_LEVELS.executive) return key
  return AUDIENCE_LEVELS.balanced
}

export function buildAudienceSection(brief = {}) {
  const level = normalizeAudienceLevel(brief?.audienceLevel)

  if (level === AUDIENCE_LEVELS.developer) {
    return `AUDIENCE ON THIS CALL: Developer / technical buyer

Coach the boss to match a technical peer:
- Name stacks, protocols, and services directly (REST/GraphQL, webhooks, Postgres, S3, Redis, CDN, OAuth, idempotent sync, OCR, rules engine).
- Assume the client understands architecture tradeoffs — skip "think of it like…" analogies.
- **Good to know:** optional — only for acronyms the boss may not know (Metrc, HL7, BAA). Do not dumb down **Say this next**.
- Keep answers tight and implementation-oriented.`
  }

  if (level === AUDIENCE_LEVELS.executive) {
    return `AUDIENCE ON THIS CALL: CEO / non-technical manager

Coach the boss to sound confident without sounding like an engineer:
- Lead with outcomes and risk reduction, not stack names.
- Prefer plain language: "connect in the background", "automatic document checks", "cloud storage", "secure file transfer", "your data stays yours".
- Avoid acronyms and product jargon in **Say this next** unless the client just used them — then mirror their term once.
- **Good to know:** use this section for the one technical term the boss should know to sound informed (define it in one plain sentence).
- Still be specific with facts (modules, timelines, what gets included) — never vague marketing speak.`
  }

  return `AUDIENCE ON THIS CALL: Mixed / default

Balance clarity and credibility:
- Use real technology names when they help (S3, Postgres, REST, webhooks) but explain the "so what" in the same breath.
- **Good to know:** define one term per turn if the boss might not know it.
- Match the client's vocabulary — if they speak technically, go deeper; if they speak in outcomes, stay higher level.`
}

export function applyAudienceToSay(sayText = '', audienceLevel = AUDIENCE_LEVELS.balanced) {
  const level = normalizeAudienceLevel(audienceLevel)
  if (!sayText?.trim() || level === AUDIENCE_LEVELS.developer) return sayText

  let text = sayText
  for (const { pattern, replacement } of EXECUTIVE_REPLACEMENTS) {
    text = text.replace(pattern, replacement)
  }

  if (level === AUDIENCE_LEVELS.executive) {
    text = softenJargon(text)
  }

  return text.replace(/\s{2,}/g, ' ').trim()
}
