function normalizeForCompare(text = '') {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenSet(text = '') {
  return new Set(normalizeForCompare(text).split(' ').filter(w => w.length > 3))
}

export function sentencesSimilar(a, b, threshold = 0.55) {
  const tokensA = tokenSet(a)
  const tokensB = tokenSet(b)
  if (!tokensA.size || !tokensB.size) return false

  let overlap = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++
  }

  const ratio = overlap / Math.min(tokensA.size, tokensB.size)
  return ratio >= threshold
}

export function extractSectionBodies(history = [], sectionLabel) {
  const pattern = new RegExp(`\\*\\*${sectionLabel}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*|$)`, 'gi')
  const bodies = []

  for (const entry of history) {
    if (entry.role !== 'assistant' || !entry.content) continue
    let match
    while ((match = pattern.exec(entry.content)) !== null) {
      const body = match[1]?.trim()
      if (body) bodies.push(body)
    }
  }

  return bodies
}

export function splitSentences(text = '') {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function stripOrphanDependentSentences(text = '') {
  if (!text) return text

  const ORPHAN_STARTERS = /^(Both|These|Those|They|It|This|That)\s+(projects?|involved|were|are|had)\b/i
  const sentences = splitSentences(text)
  const kept = sentences.filter(s => !ORPHAN_STARTERS.test(s.trim()))
  return kept.join(' ').trim()
}

const REFUSAL_SENTENCE_PATTERN = /\bI can'?t provide details\b|\bI cannot provide details\b|\bI'?m not able to (?:share|provide) (?:details|information) about\b/i

export function stripRefusalSentences(text = '') {
  if (!text) return text

  const kept = splitSentences(text).filter(s => !REFUSAL_SENTENCE_PATTERN.test(s))
  return kept.join(' ').trim()
}

export function stripRepeatedRefusal(text, priorBodies = []) {
  if (!text || !priorBodies.length) return text

  const priorRefusal = priorBodies.some(body => REFUSAL_SENTENCE_PATTERN.test(body))
  if (!priorRefusal) return text

  const kept = splitSentences(text).filter(s => !REFUSAL_SENTENCE_PATTERN.test(s))
  return kept.join(' ').trim()
}

export function stripRepeatedSentences(text, priorBodies = []) {
  if (!text || !priorBodies.length) return text

  const priorSentences = priorBodies.flatMap(splitSentences)
  if (!priorSentences.length) return text

  const kept = splitSentences(text).filter(sentence => {
    return !priorSentences.some(prior => sentencesSimilar(sentence, prior))
  })

  return kept.join(' ').trim() || text.trim()
}

export function stripRepeatedPriceMention(text, priorBodies = [], { allowRepeat = false } = {}) {
  if (!text || allowRepeat || !priorBodies.length) return text

  const priorText = priorBodies.join(' ')
  const pricePattern = /\$[\d,]+(?:\s*[-–—to]+\s*\$[\d,]+)?/gi
  const currentPrices = text.match(pricePattern) || []
  const priorPrices = priorText.match(pricePattern) || []

  if (!currentPrices.length || !priorPrices.length) return text

  const alreadySaid = currentPrices.every(price =>
    priorPrices.some(prior => normalizeForCompare(prior) === normalizeForCompare(price))
  )

  if (!alreadySaid) return text

  let cleaned = text
  for (const price of currentPrices) {
    cleaned = cleaned.replace(new RegExp(`phase one is ${price.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.?!]*[.?!]?\\s*`, 'gi'), '')
    cleaned = cleaned.replace(new RegExp(`${price.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.?!]*[.?!]?\\s*`, 'gi'), '')
  }

  return cleaned.replace(/\s{2,}/g, ' ').trim() || text
}

export function stripRepeatedComparableClient(text, priorBodies = []) {
  if (!text || !priorBodies.length) return text

  const priorText = priorBodies.join(' ')
  const comparablePattern = /\bsimilar to our work with ([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b/gi
  const currentMatches = [...text.matchAll(comparablePattern)]
  if (!currentMatches.length) return text

  let cleaned = text
  for (const match of currentMatches) {
    const name = match[1]
    if (new RegExp(`work with ${name}`, 'i').test(priorText)) {
      cleaned = cleaned.replace(match[0], '').replace(/\s{2,}/g, ' ')
    }
  }

  return cleaned.trim()
}

export function followUpAlreadyAsked(followText, priorFollowUps = []) {
  const normalized = normalizeForCompare(followText)
  if (!normalized || normalized.length < 10) return false

  return priorFollowUps.some(prior => {
    const priorNorm = normalizeForCompare(prior)
    return sentencesSimilar(normalized, priorNorm, 0.45)
  })
}

const HEALTHCARE_SIGNALS = /\b(healthcare|patient portal|medical|clinical|hospital|startup)\b/i
const LOGISTICS_SCOPE_PATTERN = /\b(job board|dispatch screen|dispatch module|trucking|freight|logistics platform)\b/gi

export function stripMismatchedScope(text, meetingContext = '') {
  if (!text || !HEALTHCARE_SIGNALS.test(meetingContext)) return text
  return text.replace(LOGISTICS_SCOPE_PATTERN, '').replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim()
}

const COMPARABLE_CLAUSE_PATTERN = /,?\s*similar to our [^.?!]*(?:project)?[^.?!]*[.?!]?/gi
const COMPARABLE_SENTENCE_PATTERN = /^[^.?!]*\bsimilar to our\b[^.?!]*[.?!]?$/i

const NON_HEALTHCARE_IN_COMPARABLE = /\b(business finance|fintech|banking|trucking|logistics|freight|dispatch|ERP|grain|finance)\b/i

const DEADLINE_PITCH_PATTERN = /\b(mid-august|weekly demos?|deliver phase one|go-live by|september launch)\b/i
const ACCOUNT_LEAD_PATTERN = /\baccount lead\b/i
const TRUST_ECHO_PATTERN = /\b(mid-august|weekly demos?|account lead|deliver phase one|keep you (?:updated|aligned)|aligned throughout|september launch)\b/i

export const TRUST_MILESTONE_FALLBACK =
  'Scope is locked in the SOW — no add-ons without a change order. Milestone one: wireframes signed off in week two. If we miss a contracted date, we finish at no extra cost.'

export function stripSimilarToOurClauses(text, meetingContext = '', priorBodies = []) {
  if (!text) return text

  const healthcare = HEALTHCARE_SIGNALS.test(meetingContext)
  const priorText = priorBodies.join(' ')

  let cleaned = text.replace(COMPARABLE_CLAUSE_PATTERN, (match) => {
    if (healthcare && NON_HEALTHCARE_IN_COMPARABLE.test(match)) return '.'
    if (/\bsimilar to our\b/i.test(priorText) && /\bsimilar to our\b/i.test(match)) return '.'
    return match
  })

  const kept = splitSentences(cleaned).filter(sentence => {
    if (!COMPARABLE_SENTENCE_PATTERN.test(sentence)) return true
    if (healthcare && NON_HEALTHCARE_IN_COMPARABLE.test(sentence)) return false
    return true
  })

  return kept.join(' ').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim()
}

export function stripRepeatedDeadlinePitch(text, priorBodies = [], { allowRepeat = false, forceStrip = false } = {}) {
  if (!text || allowRepeat || !priorBodies.length) return text

  const priorText = priorBodies.join(' ')
  if (!DEADLINE_PITCH_PATTERN.test(priorText) && !forceStrip) return text

  const kept = splitSentences(text).filter(sentence => {
    if (forceStrip && TRUST_ECHO_PATTERN.test(sentence)) return false
    if (!DEADLINE_PITCH_PATTERN.test(sentence) && !ACCOUNT_LEAD_PATTERN.test(sentence)) return true
    if (forceStrip) return false
    return !priorBodies.some(prior =>
      splitSentences(prior).some(p => sentencesSimilar(sentence, p, 0.35))
    )
  })

  return kept.join(' ').trim()
}

export function applyTrustTurnSanitize(text, { askingTrust = false, alreadyStatedDeadlinePitch = false, alreadyStatedAccountLead = false } = {}) {
  if (!text || !askingTrust) return text

  let cleaned = text
  if (alreadyStatedDeadlinePitch || alreadyStatedAccountLead) {
    const kept = splitSentences(cleaned).filter(sentence => {
      if (TRUST_ECHO_PATTERN.test(sentence)) return false
      if (alreadyStatedAccountLead && ACCOUNT_LEAD_PATTERN.test(sentence)) return false
      if (/builds trust|structured approach|accountability throughout/i.test(sentence)) return false
      return true
    })
    cleaned = kept.join(' ').trim()
  }

  if (!cleaned || splitSentences(cleaned).length === 0) {
    return TRUST_MILESTONE_FALLBACK
  }

  return cleaned
}

export function stripIndustryMismatchComparable(text, meetingContext = '') {
  return stripSimilarToOurClauses(text, meetingContext, [])
}

export function buildPriorCoachingDigest(history = []) {
  const priorSay = extractSectionBodies(history, 'Say this next')
  const priorFollow = extractSectionBodies(history, 'Follow-up')

  const saidPrices = [...priorSay.join(' ').matchAll(/\$[\d,]+(?:\s*[-–—to]+\s*\$[\d,]+)?/gi)].map(m => m[0])
  const citedClients = [...priorSay.join(' ').matchAll(/\bwork with ([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b/gi)].map(m => m[1])

  return {
    priorSay,
    priorFollow,
    priceMentionCount: saidPrices.length,
    citedClients,
  }
}
