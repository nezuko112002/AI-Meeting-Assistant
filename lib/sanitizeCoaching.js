import { applyAudienceToSay } from './audienceLevel'
import { stripFluffFromText, tightenToDirectSpeech } from './stripFluff'
import {
  applyTrustTurnSanitize,
  buildPriorCoachingDigest,
  extractSectionBodies,
  followUpAlreadyAsked,
  sentencesSimilar,
  splitSentences,
  stripMismatchedScope,
  stripIndustryMismatchComparable,
  stripRepeatedComparableClient,
  stripRepeatedDeadlinePitch,
  stripRepeatedPriceMention,
  stripRepeatedRefusal,
  stripRepeatedSentences,
  stripOrphanDependentSentences,
  stripRefusalSentences,
  stripSimilarToOurClauses,
  TRUST_MILESTONE_FALLBACK,
} from './antiRepeat'
import { stripInventedProspectAttribution } from './prospectAttribution'
import { buildPortfolioCiteLine, buildPortfolioDetailsLine, buildPortfolioNamesLine, extractCitedClientNames, pickPortfolioProjects, speakableScope } from './knowledgeHelpers'

const MIN_PROJECT_PRICE = 500

function stripQuickContextSection(text = '') {
  return text.replace(/\n?\*\*Quick context:\*\*[\s\S]*?(?=\n\*\*Follow-up:\*\*|$)/i, '\n').trim()
}

// The model is told to use canonical headings, but it sometimes falls back to the
// old emoji variants. Normalize those to canonical so the sanitizer + anti-repeat
// (which key off "Say this next" / "Follow-up") actually run on the response.
function normalizeHeadings(text = '') {
  return text
    .replace(/\*\*\s*🎯\s*Say this(?:\s+next)?\s*:\s*\*\*/gi, '**Say this next:**')
    .replace(/\*\*\s*💡\s*What they(?:'|’)re asking\s*:\s*\*\*/gi, "**What they're asking:**")
    .replace(/\*\*\s*📖\s*Good to know\s*:\s*\*\*/gi, '**Good to know:**')
    .replace(/\*\*\s*Say this\s*:\s*\*\*/gi, '**Say this next:**')
}

const INVENTED_PRICE_PATTERN = /\$[\d,]+(?:\s*[-–—to]+\s*\$[\d,]+)?(?:\s*(?:per month|\/month|monthly|a month))?/gi

const CLIENT_LIKE_PATTERN = /\b(?:companies|clients|customers|organizations)\s+like\s+([^.?!]+)/gi

function normalizeForCompare(text = '') {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function isNameAllowed(name, allowedSet) {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return true
  if (allowedSet.has(normalized)) return true

  for (const allowed of allowedSet) {
    if (normalized.includes(allowed) || allowed.includes(normalized)) return true
  }
  return false
}

export function sanitizeSayThisNext(sayText) {
  return tightenToDirectSpeech(stripRefusalSentences(stripFluffFromText(sayText)), { maxSentences: 3 })
}

function stripQuestionsFromSay(sayText = '') {
  const statements = []
  const questions = []

  for (const sentence of splitSentences(sayText)) {
    if (sentence.trim().endsWith('?')) questions.push(sentence.trim())
    else statements.push(sentence.trim())
  }

  return {
    say: statements.join(' ').trim(),
    trailingQuestion: questions[questions.length - 1] || '',
  }
}

function sayCitesPortfolioName(sayText = '', names = []) {
  const lower = sayText.toLowerCase()
  return names.some(name => {
    const n = name?.trim().toLowerCase()
    return n && n.length > 2 && lower.includes(n)
  })
}

function sayLooksLikeClosingPivot(sayText = '') {
  return /\b(timeline|decision-?maker|signing the sow|budget range|who will be the)\b/i.test(sayText)
}

function containsRawServiceTypes(text = '') {
  return /\bweb design,\s*web application\b/i.test(text)
    || /\bapp development for\b/i.test(text)
    || /\bsoftware development for\b/i.test(text)
    || /microsoft stack.*azure/i.test(text)
    || /build an mobile app/i.test(text)
}

function isProspectOwnedPortfolioPhrase(text = '') {
  return /\b(?:our|my|investment|loan|document|deal)\s+portfolio\b/i.test(text)
    || /\bportfolio contains\b/i.test(text)
    || /\bportfolio spans\b/i.test(text)
}

function portfolioIntentActive(intent = {}) {
  if (intent.askingTechnicalHow || intent.askingSecurityCompliance) return false
  if (isProspectOwnedPortfolioPhrase(intent.latestClientText || '')) return false
  return Boolean(
    intent.askingIndustryExperience
    || intent.askingPortfolioNames
    || intent.askingPortfolioDetails
    || intent.portfolioObjection
    || (intent.askingCredibility && !intent.askingTechnicalHow)
  )
}

const OFF_TOPIC_TECHNICAL = /\b(freight|logistics|dispatch|trucking|microsoft stack|hosted by azure|we built a web application that involved)\b/i
const INCONSISTENCY_ANSWER = /\b(review queue|appraisal value, budget line|cross-checks appraisal)\b/i
const INTEGRATION_ANSWER = 'Integrate over REST APIs and webhooks into your LOS, CRM, accounting system, and SharePoint — reads and writes happen in the background, no rip-and-replace.'
const AI_TRAINING_ANSWER = 'No — your loan documents never train public models. We use enterprise API agreements with zero retention on your payloads, and contract language that your data stays in your tenant.'

function resolveLatestClientText(intent = {}, options = {}) {
  return (intent.latestClientText || options.latestClientText || '').trim().toLowerCase()
}

function isIntegrationQuestion(latest = '') {
  return /\b(integrat|los\b|sharepoint|crm|accounting|servicing platform|without disrupting|existing systems|existing workflows)\b/i.test(latest)
}

function isInconsistencyQuestion(latest = '') {
  return /\b(inconsistenc|catch that automatically|identify inconsisten|appraisal says)\b/i.test(latest)
}

function isScaleQuestion(latest = '') {
  return /\b(scale|million|architecture)\b/i.test(latest) && !/\bexperience|worked|built for|similar companies\b/i.test(latest)
}

function isAiTrainingQuestion(latest = '') {
  return /\b(train public|used to train|training (?:public )?ai|train (?:on|with) (?:our|my|their|customer) data|fine-?tun.*(?:public|model))\b/i.test(latest)
}

function isWrongAnswerForQuestion(latest = '', sayText = '') {
  if (!latest || !sayText) return false
  if (isAiTrainingQuestion(latest)) {
    return INCONSISTENCY_ANSWER.test(sayText)
      || /\b(ocr|rules engine|review queue|appraisal value, budget line)\b/i.test(sayText)
      || !/\b(no|never|zero retention|public models?|your tenant)\b/i.test(sayText)
  }
  if (isIntegrationQuestion(latest)) {
    return INCONSISTENCY_ANSWER.test(sayText)
      || (!/\b(rest api|webhook|sftp|idempotent)\b/i.test(sayText) && /\b(ocr|rules engine|review queue)\b/i.test(sayText))
  }
  if (isInconsistencyQuestion(latest)) {
    return /\b(rest api|webhook|integrate over)\b/i.test(sayText) && !/\b(rules engine|ocr|cross-check)\b/i.test(sayText)
  }
  if (isScaleQuestion(latest)) {
    return INCONSISTENCY_ANSWER.test(sayText) || (/\bwe built\b/i.test(sayText))
  }
  return false
}

function buildTechnicalSayFallback(intent = {}, meetingContext = '', options = {}) {
  const latest = resolveLatestClientText(intent, options)
  const ctx = meetingContext.toLowerCase()

  if (isAiTrainingQuestion(latest)) {
    return AI_TRAINING_ANSWER
  }
  if (isIntegrationQuestion(latest)) {
    return INTEGRATION_ANSWER
  }
  if (isScaleQuestion(latest)) {
    return 'Store files in S3, index metadata in Postgres, serve through a CDN, and cache hot reads in Redis — that scales to millions of documents without slowing search.'
  }
  if (/\bhallucinat|summariz.*loan|ai.*summar\b/i.test(latest)) {
    return 'Extract fields with OCR first, generate summaries only from those extracted values, and run a rules engine cross-check against source documents — anything that fails validation goes to a human review queue.'
  }
  if (isInconsistencyQuestion(latest)) {
    return 'Run OCR on each document, extract the key fields, then a rules engine cross-checks appraisal value, budget line, and borrower financials — mismatches land in a review queue before anyone signs off.'
  }
  if (/\bhow (?:would|will|do) you build|support all this|document types\b/i.test(latest)) {
    return 'Store appraisals and financials in S3, index deal metadata in Postgres, expose a REST API for your LOS and SharePoint, and run OCR plus a rules engine on draw requests and insurance certificates.'
  }

  if (/\bmetrc|inventory|drift|harvest\b/.test(ctx) && !isIntegrationQuestion(latest)) {
    return 'Queue every Metrc write locally, sync on a schedule with idempotent retries, and run a nightly reconciliation job so counts self-heal if their API drops mid-harvest.'
  }
  if (/\bsftp|as\/400|csv\b/.test(latest)) {
    return 'Poll their SFTP drop on a schedule, parse the CSV into staging tables, and upsert into the portal with idempotent keys so re-sends never duplicate rows.'
  }
  if (/\bretool|chatgpt|tenant|upload|photo|mold\b/.test(latest)) {
    return 'Keep Retool as the UI — we expose a REST API behind it, store uploads in private S3 with signed URLs, and lock access with role-based permissions per property manager.'
  }
  if (/\bblockchain|provenance|faa audit\b/.test(latest)) {
    return 'Skip blockchain — use an append-only audit log with signed timestamps and immutable event storage; that satisfies FAA traceability without the ops overhead.'
  }

  return ''
}

function buildWhatTheyreAskingFallback(intent = {}, options = {}) {
  const latest = resolveLatestClientText(intent, options)
  if (isInconsistencyQuestion(latest)) {
    return 'Whether the platform can automatically flag mismatches between documents (e.g. appraisal value vs budget line).'
  }
  if (isIntegrationQuestion(latest)) {
    return 'How to connect with their existing systems without disrupting current workflows.'
  }
  if (isScaleQuestion(latest)) {
    return 'How the architecture handles very large document volume without slowing down.'
  }
  if (isAiTrainingQuestion(latest)) {
    return 'Whether their data would be used to train public AI models.'
  }
  if (/\bhallucinat|summariz.*loan\b/i.test(latest)) {
    return 'How to keep AI-generated document summaries accurate and grounded in source files.'
  }
  return ''
}

function buildTechnicalFollowUp(intent = {}, options = {}) {
  const latest = resolveLatestClientText(intent, options)
  if (/\binconsistenc|catch that automatically\b/i.test(latest)) {
    return 'Which document pairs cause the most manual review for you today — appraisal vs budget, or something else?'
  }
  if (/\bintegrat|los|sharepoint|without disrupting\b/i.test(latest)) {
    return 'Which integration is the highest risk if we get it wrong — LOS, SharePoint, or accounting?'
  }
  if (isScaleQuestion(latest)) {
    return 'What volume of documents do you need searchable at once?'
  }
  if (isAiTrainingQuestion(latest)) {
    return 'Do you need zero-retention language in the contract, or is a standard enterprise API agreement enough for your counsel?'
  }
  return 'What is the hardest part of your current document workflow?'
}

function sanitizeWhatTheyreAsking(text = '', intent = {}, options = {}) {
  const match = text.match(/(\*\*What they're asking:\*\*\s*)([\s\S]*?)(?=\n\*\*[^\n*]+:\*\*|$)/i)
  if (!match || (!intent.askingTechnicalHow && !intent.askingSecurityCompliance)) return text

  const body = match[2].trim().toLowerCase()
  const latest = resolveLatestClientText(intent, options)
  const mismatched = (
    (isInconsistencyQuestion(latest) && /\b(lending types|past projects?|industry experience|integrat|existing systems)\b/i.test(body) && !/\binconsisten|mismatch|flag\b/i.test(body))
    || (isIntegrationQuestion(latest) && /\b(lending types|inconsisten|ocr|rules engine|past projects?)\b/i.test(body) && !/\bintegrat|workflow|disrupt\b/i.test(body))
    || (isScaleQuestion(latest) && /\b(lending types|inconsisten)\b/i.test(body))
    || (isAiTrainingQuestion(latest) && /\b(ocr|rules engine|integrat|inconsisten)\b/i.test(body) && !/\btrain|public models?|ai\b/i.test(body))
  )

  if (!mismatched) return text

  const replacement = buildWhatTheyreAskingFallback(intent, options)
  if (!replacement) return text

  return text.replace(match[0], `${match[1]}${replacement}`)
}

function polishTechnicalSay(sayText = '', intent = {}, meetingContext = '', options = {}) {
  if (!intent.askingTechnicalHow && !intent.askingSecurityCompliance) return sayText

  const latest = resolveLatestClientText(intent, options)

  if (isAiTrainingQuestion(latest)) {
    return AI_TRAINING_ANSWER
  }

  const clean = buildTechnicalSayFallback(intent, meetingContext, options)

  if (intent.askingTechnicalHow && isWrongAnswerForQuestion(latest, sayText) && clean) {
    return clean
  }

  if (intent.askingTechnicalHow) {
    if (isIntegrationQuestion(latest) && !/\b(rest api|webhook|sftp|idempotent)\b/i.test(sayText)) {
      return INTEGRATION_ANSWER
    }

    const offTopic = OFF_TOPIC_TECHNICAL.test(sayText)
      || containsRawServiceTypes(sayText)
      || (isInconsistencyQuestion(latest) && !/\b(rules engine|ocr|cross-check|extract)\b/i.test(sayText))

    if (offTopic && clean) return clean

    if (/\bwe built\b|\bwe've built\b/i.test(sayText)) {
      return clean || sayText.replace(/\b(?:yes,?\s*)?we(?:'ve)? built[^.?!]+[.?!]?\s*/gi, '').trim()
    }
    if (isScaleQuestion(latest) && !/\b(s3|postgres|cdn|redis)\b/i.test(sayText) && clean) {
      return clean
    }
    if (isInconsistencyQuestion(latest) && clean) {
      return clean
    }
    if (/\bseamless data exchange|without disrupting your workflows\b/i.test(sayText) && clean) {
      return clean
    }
  }

  if (intent.askingSecurityCompliance && /\btrain public|used to train|training (?:public )?ai\b/i.test(latest)) {
    return 'No — your loan documents never train public models. We use enterprise API agreements with zero retention on your payloads, and contract language that your data stays in your tenant.'
  }

  return sayText
}

function forcePortfolioSay(intent = {}, portfolioProjects = []) {
  if (!portfolioProjects?.length) return ''

  if (intent.askingPortfolioDetails) return buildPortfolioDetailsLine(portfolioProjects)
  if (intent.askingPortfolioNames) return buildPortfolioNamesLine(portfolioProjects)
  if (
    intent.portfolioObjection
    || intent.askingIndustryExperience
    || (intent.askingCredibility && !intent.askingTechnicalHow)
  ) {
    return buildPortfolioCiteLine(portfolioProjects)
  }
  return ''
}

function portfolioFollowUp(intent = {}, priorFollow = [], clientCompany = '', meetingContext = '') {
  if (intent.askingPortfolioDetails) {
    return 'Which of those features matters most for your rebuild?'
  }
  if (intent.askingPortfolioNames) {
    return 'Want a quick walkthrough of what we built for either one?'
  }
  const ctx = `${meetingContext} ${intent.latestClientText || ''}`.toLowerCase()
  if (/\b(lending|loan|mortgage|finance|real estate|capital)\b/.test(ctx)) {
    return 'Which of those builds is closest to your deal flow?'
  }
  if (/\b(cannabis|cultivat|metrc)\b/.test(ctx)) {
    return 'Which compliance piece is highest priority — Metrc sync or audit exports?'
  }
  if (priorFollow.some(f => /\bwhat kind of trucking\b/i.test(f))) {
    const company = clientCompany || 'your team'
    return `Which of those builds is closest to what ${company} needs?`
  }
  return 'Which of those builds is closest to what you need?'
}

function parseSayPriceAmount(match = '') {
  const hasK = /\d{1,3}k\b/i.test(match)
  const numeric = parseFloat((match.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''))
  return hasK ? numeric * 1000 : numeric
}

function priceIsAllowed(match, allowed = []) {
  const lower = match.toLowerCase()
  const normalizedMatch = lower.replace(/[^\d$,.k-–]/g, '')
  return allowed.some(price => {
    const norm = price.toLowerCase().replace(/[^\d$,.k-–]/g, '')
    return norm && (norm.includes(normalizedMatch) || normalizedMatch.includes(norm))
  })
}

function sayContainsInvalidProjectPrice(text = '', { documentedPrices = [], clientStatedPrices = [] } = {}) {
  const prices = text.match(/\$[\d,]+(?:\.\d{2})?(?:\s*[-–—to]+\s*\$[\d,]+(?:\.\d{2})?)?|\b\d{1,3}k\b/gi) || []
  if (!prices.length) return false

  const allowed = [...documentedPrices, ...clientStatedPrices]
  for (const price of prices) {
    const amount = parseSayPriceAmount(price)
    const allowedMatch = priceIsAllowed(price, allowed)
    if (allowedMatch && amount >= MIN_PROJECT_PRICE) continue
    if (amount > 0 && amount < MIN_PROJECT_PRICE && !/\d{1,3}k\b/i.test(price)) return true
    if (documentedPrices.length && !allowedMatch) return true
  }
  return false
}

function sayNeedsPriceFallback(text = '', { intent, documentedPrices = [], priceEstimate = null } = {}) {
  if (!intent?.askingPrice || !text?.trim()) return false
  if (/a fixed phase-one range after we lock scope/i.test(text)) return true
  if (sayContainsInvalidProjectPrice(text, { documentedPrices })) return true
  if (!documentedPrices.length && /\$[\d,]+|\d{1,3}k\b/i.test(text)) return true
  if (priceEstimate?.rangeText && !/\$[\d,]{3,}|\d{1,3}k\b/i.test(text)) return true
  if (priceEstimate?.rangeText && /module once scope is locked|fixed dollar range in the sow after this call/i.test(text)) return true
  return false
}

function buildPriceSayFallback({
  priceEstimate,
  intent = {},
  fallbackNames = [],
  portfolioProjects = [],
} = {}) {
  if (intent.clientStatedBudget) {
    const budget = intent.clientBudgetText || 'your stated budget'
    return `For ${budget}, we'll map phase-one scope to that number — I'll break out what's in phase one vs phase two on the SOW so finance can sign off.`
  }

  if (priceEstimate?.rangeText) {
    const comp = priceEstimate.comparableName || fallbackNames[0] || 'a comparable build from our portfolio'
    const scope = priceEstimate.comparableScope || speakableScope(portfolioProjects[0] || {})
    if (priceEstimate.monthlyRateText) {
      return `For a project like yours, phase one is typically ${priceEstimate.rangeText} — structured at ${priceEstimate.monthlyRateText}, similar to the ${scope} we delivered for ${comp}. That covers core platform setup, auth, listings, and your must-have integrations.`
    }
    return `For a project like yours, phase one typically runs ${priceEstimate.rangeText} — in the same ballpark as ${scope} for ${comp}. That covers core platform setup, auth, and your must-have integrations; we'll tighten the exact module list once you confirm priorities.`
  }

  const comp = fallbackNames[0]
  if (comp) {
    return `We price phase one by module once scope is locked — similar to the ${speakableScope(portfolioProjects[0] || {})} we built for ${comp}. I'll send a fixed dollar range in the SOW after we confirm your must-haves.`
  }

  return `We price phase one by module once scope is locked — core platform, auth, and must-have integrations. I'll send a fixed dollar range in the SOW after this call once we confirm priorities.`
}

function buildSayFallback(options = {}) {
  const {
    clientCompany = '',
    fallbackNames = [],
    portfolioProjects = [],
    intent = {},
    websiteSnippet = '',
    priorConversations = '',
    meetingContext = '',
    priceEstimate = null,
  } = options

  const portfolioLine = portfolioIntentActive(intent) ? forcePortfolioSay(intent, portfolioProjects) : ''
  if (portfolioLine) return portfolioLine

  if (intent.askingTrust) {
    return TRUST_MILESTONE_FALLBACK
  }

  if (intent.askingSecurityCompliance && isAiTrainingQuestion((intent.latestClientText || '').toLowerCase())) {
    return AI_TRAINING_ANSWER
  }

  if (intent.askingTechnicalHow) {
    const technical = buildTechnicalSayFallback(intent, meetingContext, { latestClientText: intent.latestClientText })
    if (technical) return technical
  }

  if (intent.askingSecurityCompliance) {
    const latest = (intent.latestClientText || '').toLowerCase()
    if (/\bliable|liability|who(?:'s| is) (?:liable|responsible)\b/i.test(meetingContext)) {
      return 'Under our BAA, we own securing the bucket — encryption at rest, private buckets, least-privilege IAM, and audit logging. You own access policies on your side; we document both in the contract.'
    }
    return 'We sign a BAA before any PHI touches our systems and we are pursuing SOC 2 Type II — I can share the auditor timeline and our current security one-pager.'
  }

  if (intent.askingPrice) {
    return buildPriceSayFallback({ priceEstimate, intent, fallbackNames, portfolioProjects })
  }

  if (intent.askingIndustryExperience || (intent.askingCredibility && !intent.askingTechnicalHow)) {
    const names = fallbackNames.filter(Boolean).slice(0, 2)
    const portfolioLine = forcePortfolioSay(intent, portfolioProjects)
    if (portfolioLine) return portfolioLine
    if (names.length >= 2) {
      return `Yes — we built ${speakableScope(portfolioProjects[0] || {})} for ${names[0]} and ${speakableScope(portfolioProjects[1] || {})} for ${names[1]}.`
    }
    if (names.length === 1) {
      return `Yes — we built ${speakableScope(portfolioProjects[0] || {})} for ${names[0]}.`
    }
    return 'Yes — we have comparable builds in our portfolio; I can walk through two that match your industry.'
  }

  if (intent.askingWhatYouKnow || intent.askingAboutCompany) {
    const company = clientCompany || 'your company'
    if (priorConversations?.trim()) {
      const prep = priorConversations.trim().slice(0, 160)
      return `From our prep: ${prep}${priorConversations.length > 160 ? '…' : ''}`
    }
    if (websiteSnippet?.trim()) {
      const snippet = websiteSnippet.trim().slice(0, 100)
      return `${company} — ${snippet}${websiteSnippet.length > 100 ? '…' : ''}`
    }
    return `${company} is on our brief — walk me through what your team handles day to day.`
  }

  return ''
}

export function stripInventedPricing(text, { allowPricing = false, documentedPrices = [], clientStatedPrices = [] } = {}) {
  if (!text) return text

  const allowedPriceStrings = [
    ...documentedPrices,
    ...clientStatedPrices,
  ]

  return text.replace(INVENTED_PRICE_PATTERN, (match) => {
    if (priceIsAllowed(match, allowedPriceStrings)) return match

    const lower = match.toLowerCase()
    const numeric = parseFloat((match.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''))
    const effectiveNumeric = /\d{1,3}k\b/i.test(lower) ? numeric * 1000 : numeric

    if (effectiveNumeric > 0 && effectiveNumeric < MIN_PROJECT_PRICE && !/\d{1,3}k\b/i.test(lower)) {
      return allowPricing ? 'a fixed phase-one range after we lock scope' : 'your stated budget range'
    }

    if (allowPricing && !documentedPrices.length && !clientStatedPrices.length) {
      return 'a fixed phase-one range after we lock scope'
    }

    if (!allowPricing) return 'your stated budget range'
    return 'a fixed phase-one range after we lock scope'
  })
}

const PAST_CLIENT_REF_PATTERN = /\b(?:for|with|like|such as|including)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/g

export function stripUnknownPastClientCitations(text, { allowedNames = [], fallbackNames = [] } = {}) {
  if (!text || !allowedNames.length) return text

  const allowedSet = new Set(allowedNames.map(n => n.trim().toLowerCase()).filter(Boolean))
  const fallback = fallbackNames.slice(0, 2).join(' and ') || 'a comparable healthcare project from our portfolio'

  return text.replace(PAST_CLIENT_REF_PATTERN, (match, name) => {
    if (isNameAllowed(name, allowedSet)) return match
    return `for ${fallback}`
  })
}

export function stripFabricatedClientNames(text, { allowedNames = [], clientCompany = '', fallbackNames = [] } = {}) {
  if (!text) return text

  const allowedSet = new Set(
    [...allowedNames, clientCompany]
      .map(name => name?.trim().toLowerCase())
      .filter(Boolean)
  )

  if (!allowedSet.size) return text

  const fallback = (fallbackNames.length ? fallbackNames : allowedNames).slice(0, 2).join(' and ')

  return text.replace(CLIENT_LIKE_PATTERN, (match, namesPart) => {
    const cited = namesPart
      .split(/\s+and\s+|,\s*/i)
      .map(s => s.trim())
      .filter(Boolean)

    const invalid = cited.filter(name => !isNameAllowed(name, allowedSet))
    if (!invalid.length) return match

    if (fallback) {
      return `projects we've delivered for companies like ${fallback}`
    }
    return 'similar work in our portfolio'
  })
}

function examplesAllowedThisTurn(intent = {}, allowPricing = false) {
  if (intent.askingTechnicalHow || intent.askingSecurityCompliance) return false
  if (intent.askingTrust && !intent.portfolioObjection) return false
  return Boolean(
    intent.askingIndustryExperience
    || intent.askingPortfolioNames
    || intent.askingPortfolioDetails
    || (intent.askingCredibility && !intent.askingTechnicalHow)
    || intent.portfolioObjection
    || allowPricing
  )
}

function stripPriceLanguageUnlessAsked(text = '', intent = {}, allowPricing = false) {
  if (!text || allowPricing || intent.askingPrice) return text
  return splitSentences(text)
    .filter(s => !/\b(?:phase-one estimate|phase one estimate|your stated budget|recommended.*estimate|ballpark|within that budget|eight thousand dollars aligns)\b/i.test(s))
    .join(' ')
    .trim()
}

function redactPortfolioNamesInline(text = '', names = []) {
  let cleaned = text
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cleaned = cleaned
      .replace(new RegExp(`\\b(?:for|with|at|from|on|using)\\s+${escaped}\\b`, 'gi'), '')
      .replace(new RegExp(`\\b${escaped}(?:'s)?\\b`, 'gi'), '')
  }
  return cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
}

// The client complained that examples (Heartline, ALCO, etc.) get cited in EVERY answer.
// Only allow past-client name-drops on turns where the client actually asked about
// experience / past work / credibility, or where we're anchoring a price comparable.
export function stripUnsolicitedPortfolioCitations(text, { allowedNames = [], intent = {}, allowPricing = false } = {}) {
  if (!text || !allowedNames.length) return text
  if (examplesAllowedThisTurn(intent, allowPricing)) return text

  const names = allowedNames.map(n => n.trim()).filter(n => n.length > 2)
  if (!names.length) return text

  const namePattern = new RegExp(
    `\\b(?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'i'
  )

  let cleaned = redactPortfolioNamesInline(text, names)
  const kept = splitSentences(cleaned).filter(sentence => !namePattern.test(sentence))
  return kept.join(' ').trim()
}

// "Good to know" was repeating the same definition turn after turn (e.g. the
// webhook explanation). Drop it when it echoes a prior turn's "Good to know".
export function stripRepeatedGoodToKnow(text, history = []) {
  const match = text.match(/\n?\*\*Good to know:\*\*\s*([\s\S]*?)(?=\n\*\*[^\n*]+:\*\*|$)/i)
  if (!match || !match[1].trim()) return text

  const current = match[1].trim()
  const priors = extractSectionBodies(history, 'Good to know')
  if (!priors.length) return text

  const repeated = priors.some(prior => sentencesSimilar(current, prior, 0.6))
  if (!repeated) return text

  return text.replace(match[0], '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function dedupeFollowUpSection(text) {
  const sayMatch = text.match(/\*\*Say this next:\*\*\s*([\s\S]*?)(?=\n\*\*[^\n*]+:\*\*|$)/i)
  const followMatch = text.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)
  if (!sayMatch || !followMatch) return text

  const sayBody = normalizeForCompare(sayMatch[1])
  const followBody = normalizeForCompare(followMatch[1])
  const followQuestion = followBody.replace(/\s+/g, ' ')

  if (!followQuestion || followQuestion.length < 12) return text

  if (sayBody.includes(followQuestion) || followQuestion.split(' ').filter(w => w.length > 4).every(w => sayBody.includes(w))) {
    return text.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '')
  }

  return text
}

export function sanitizeCoachingResponse(text, options = {}) {
  if (!text) return text

  const {
    history = [],
    meetingContext = '',
    allowPriceRepeat = false,
    askingTrust = false,
    alreadyStatedDeadlinePitch = false,
    alreadyStatedAccountLead = false,
    intent = {},
    websiteSnippet = '',
    priorConversations = '',
  } = options

  const { priorSay, priorFollow } = buildPriorCoachingDigest(history)

  let result = stripQuickContextSection(normalizeHeadings(text))

  const sayMatch = result.match(/(\*\*Say this next:\*\*\s*)([\s\S]*?)(?=\n\*\*[^\n*]+:\*\*|$)/i)
  if (sayMatch) {
    const [, label, sayBody] = sayMatch
    let sanitizedSay = sanitizeSayThisNext(sayBody)
    sanitizedSay = stripMismatchedScope(sanitizedSay, meetingContext)
    sanitizedSay = stripSimilarToOurClauses(sanitizedSay, meetingContext, priorSay)
    sanitizedSay = stripIndustryMismatchComparable(sanitizedSay, meetingContext)
    sanitizedSay = stripInventedProspectAttribution(sanitizedSay, {
      portfolioNames: options.portfolioNames || options.allowedNames || [],
      factContext: options.factContext || '',
      clientCompany: options.clientCompany || '',
    })
    sanitizedSay = stripRepeatedSentences(sanitizedSay, priorSay)
    sanitizedSay = stripRepeatedRefusal(sanitizedSay, priorSay)
    sanitizedSay = stripRefusalSentences(sanitizedSay)
    sanitizedSay = stripOrphanDependentSentences(sanitizedSay)
    sanitizedSay = stripRepeatedDeadlinePitch(sanitizedSay, priorSay, {
      allowRepeat: Boolean(options.allowDeadlineRepeat),
      forceStrip: askingTrust && alreadyStatedDeadlinePitch,
    })
    sanitizedSay = applyTrustTurnSanitize(sanitizedSay, {
      askingTrust,
      alreadyStatedDeadlinePitch,
      alreadyStatedAccountLead,
    })
    sanitizedSay = stripRepeatedPriceMention(sanitizedSay, priorSay, { allowRepeat: allowPriceRepeat })
    sanitizedSay = stripRepeatedComparableClient(sanitizedSay, priorSay)
    sanitizedSay = stripUnsolicitedPortfolioCitations(sanitizedSay, {
      allowedNames: options.allowedNames || [],
      intent,
      allowPricing: Boolean(options.allowPricing),
    })
    sanitizedSay = stripUnknownPastClientCitations(sanitizedSay, options)
    sanitizedSay = stripFabricatedClientNames(sanitizedSay, options)
    sanitizedSay = stripInventedPricing(sanitizedSay, options)
    if (intent.askingPrice && sayNeedsPriceFallback(sanitizedSay, options)) {
      sanitizedSay = buildPriceSayFallback({
        priceEstimate: options.priceEstimate,
        intent,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
      })
    }
    sanitizedSay = stripPriceLanguageUnlessAsked(sanitizedSay, intent, Boolean(options.allowPricing))

    if (priorSay.length && sanitizedSay.trim()) {
      const lastPrior = priorSay[priorSay.length - 1]
      if (sentencesSimilar(sanitizedSay, lastPrior, 0.62)) {
        sanitizedSay = ''
      }
    }

    if (!intent.askingPrice && !options.allowPricing) {
      sanitizedSay = stripRepeatedPriceMention(sanitizedSay, priorSay, { allowRepeat: false })
    }

    sanitizedSay = tightenToDirectSpeech(stripFluffFromText(sanitizedSay), {
      maxSentences: (intent.askingWhatYouKnow || intent.askingAboutCompany) ? 2 : 3,
    })

    const { say: sayWithoutQuestions, trailingQuestion } = stripQuestionsFromSay(sanitizedSay)
    sanitizedSay = sayWithoutQuestions || sanitizedSay

    const needsPortfolioLine = portfolioIntentActive(intent)
    const credibilityMissing = needsPortfolioLine
      && (!sayCitesPortfolioName(sanitizedSay, options.fallbackNames) || sayLooksLikeClosingPivot(sanitizedSay))

    const sayTooWeak = !sanitizedSay.trim()
      || sanitizedSay.length < 25
      || /^(This aligns|This is similar|This is comparable|This is in line|For that price, we can implement)\b/i.test(sanitizedSay)
      || credibilityMissing
      || (needsPortfolioLine && containsRawServiceTypes(sanitizedSay))
      || (intent.askingTechnicalHow && containsRawServiceTypes(sanitizedSay))
      || (intent.askingPrice && sayContainsInvalidProjectPrice(sanitizedSay, options))
      || (intent.askingPrice && intent.clientStatedBudget && (
        !/\b(booking|marketing|scheduling|eligibility|module|site refresh)\b/i.test(sanitizedSay)
        || /\b(modules?|be specific|what would we get)\b/i.test(options.latestClientText || '')
      ))
      || (intent.askingSecurityCompliance && priorSay.some(p => sentencesSimilar(sanitizedSay, p, 0.5)))

    if (needsPortfolioLine && options.portfolioProjects?.length) {
      const forced = forcePortfolioSay(intent, options.portfolioProjects)
      if (forced) sanitizedSay = forced
    } else if (sayTooWeak) {
      const fallback = buildSayFallback({
        clientCompany: options.clientCompany,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
        intent,
        websiteSnippet,
        priorConversations,
        meetingContext: options.meetingContext || meetingContext,
        priceEstimate: options.priceEstimate,
      })
      if (fallback) sanitizedSay = fallback
    }

    if (!examplesAllowedThisTurn(intent, Boolean(options.allowPricing))) {
      sanitizedSay = stripUnsolicitedPortfolioCitations(sanitizedSay, {
        allowedNames: options.allowedNames || [],
        intent,
        allowPricing: Boolean(options.allowPricing),
      })
      if (!sanitizedSay.trim() || sanitizedSay.length < 25) {
        const technicalFallback = buildSayFallback({
          clientCompany: options.clientCompany,
          fallbackNames: options.fallbackNames,
          portfolioProjects: options.portfolioProjects || [],
          intent,
          websiteSnippet,
          priorConversations,
          meetingContext: options.meetingContext || meetingContext,
          priceEstimate: options.priceEstimate,
        })
        if (technicalFallback) sanitizedSay = technicalFallback
      }
    }

    if (
      (intent.askingTechnicalHow || intent.askingSecurityCompliance)
      && (
        !sanitizedSay.trim()
        || isWrongAnswerForQuestion(resolveLatestClientText(intent, options), sanitizedSay)
        || containsRawServiceTypes(sanitizedSay)
        || /\bwe built\b/i.test(sanitizedSay)
        || (needsPortfolioLine && sayCitesPortfolioName(sanitizedSay, options.fallbackNames))
      )
    ) {
      const technicalFallback = buildSayFallback({
        clientCompany: options.clientCompany,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
        intent,
        websiteSnippet,
        priorConversations,
        meetingContext: options.meetingContext || meetingContext,
        priceEstimate: options.priceEstimate,
      })
      if (technicalFallback) sanitizedSay = technicalFallback
    }

    if (!sanitizedSay.trim()) {
      const lastResort = buildSayFallback({
        clientCompany: options.clientCompany,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
        intent,
        websiteSnippet,
        priorConversations,
        meetingContext: options.meetingContext || meetingContext,
        priceEstimate: options.priceEstimate,
      })
      if (lastResort) sanitizedSay = lastResort
    }

    if (!sanitizedSay.trim() && intent.askingPrice) {
      sanitizedSay = buildPriceSayFallback({
        priceEstimate: options.priceEstimate,
        intent,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
      })
    }

    if (intent.askingPrice && sayContainsInvalidProjectPrice(sanitizedSay, options)) {
      sanitizedSay = buildPriceSayFallback({
        priceEstimate: options.priceEstimate,
        intent,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
      })
    }

    if (intent.askingTrust && !intent.askingTechnicalHow && /\b(postgres|rest api|webhook|s3|redis)\b/i.test(sanitizedSay)) {
      sanitizedSay = TRUST_MILESTONE_FALLBACK
    }

    if (
      intent.askingPrice
      && intent.clientStatedBudget
      && /\b(modules?|be specific|what would we get)\b/i.test(options.latestClientText || '')
    ) {
      sanitizedSay = buildPriceSayFallback({
        priceEstimate: options.priceEstimate,
        intent,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
      })
    }

    if (intent.askingTechnicalHow) {
      sanitizedSay = polishTechnicalSay(sanitizedSay, intent, options.meetingContext || meetingContext, options)
    }

    if (intent.askingSecurityCompliance) {
      sanitizedSay = polishTechnicalSay(sanitizedSay, intent, options.meetingContext || meetingContext, options)
    }

    if (intent.askingPrice && sayNeedsPriceFallback(sanitizedSay, options)) {
      sanitizedSay = buildPriceSayFallback({
        priceEstimate: options.priceEstimate,
        intent,
        fallbackNames: options.fallbackNames,
        portfolioProjects: options.portfolioProjects || [],
      })
    }

    sanitizedSay = applyAudienceToSay(sanitizedSay, options.audienceLevel)

    const prefix = result.slice(0, sayMatch.index)
    result = `${prefix}${label}${sanitizedSay}${result.slice(sayMatch.index + sayMatch[0].length)}`

    if (trailingQuestion && !result.match(/\*\*Follow-up:\*\*/i)) {
      result = `${result.trim()}\n\n**Follow-up:** ${trailingQuestion}`
    }
  } else {
    result = stripFluffFromText(stripFabricatedClientNames(stripInventedPricing(result, options), options))
  }

  const followMatch = result.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)
  if (followMatch?.[1]?.trim()) {
    let sanitizedFollow = stripFluffFromText(followMatch[1])
    if (options.clientRejectedTmsReplacement && /\b(tms|transportation management)\b/i.test(sanitizedFollow)) {
      sanitizedFollow = ''
    }
    if (followUpAlreadyAsked(sanitizedFollow, priorFollow)) {
      result = result.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '')
    } else if (sanitizedFollow) {
      result = result.replace(/\*\*Follow-up:\*\*[\s\S]*$/i, `**Follow-up:** ${sanitizedFollow}`)
    }
  }

  result = stripRepeatedGoodToKnow(result, history)
  result = dedupeFollowUpSection(result)
  result = stripQuickContextSection(result)

  const needsPortfolioAnswer = portfolioIntentActive(intent)
  if (needsPortfolioAnswer) {
    const followBody = result.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)?.[1]?.trim() || ''
    const desiredFollow = portfolioFollowUp(intent, priorFollow, options.clientCompany, options.meetingContext || meetingContext)
    if (!followBody || sayLooksLikeClosingPivot(followBody) || followUpAlreadyAsked(followBody, priorFollow)) {
      result = result.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '').trim()
      result = `${result}\n\n**Follow-up:** ${desiredFollow}`
    }
  } else if (intent.askingTechnicalHow || intent.askingSecurityCompliance) {
    const followBody = result.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)?.[1]?.trim() || ''
    if (!followBody || sayLooksLikeClosingPivot(followBody) || /\blending types|past projects?\b/i.test(followBody)) {
      result = result.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '').trim()
      result = `${result}\n\n**Follow-up:** ${buildTechnicalFollowUp(intent, options)}`
    }
  }

  result = sanitizeWhatTheyreAsking(result, intent, options)

  return result.trim()
}

function getClientText(utterances = [], speakerMap = {}) {
  return utterances
    .filter(u => {
      const label = (speakerMap?.[u.speaker] || u.speaker || '').toString().trim().toLowerCase()
      if (u.speaker === 'You' || u.speaker === 'Boss' || label === 'boss' || label === 'you') return false
      return u.speaker === 'Client' || label === 'client' || Boolean(u.speaker)
    })
    .map(u => u.text || '')
    .join(' ')
    .toLowerCase()
}

export function detectClientIntent(latestUtterances = [], speakerMap = {}, options = {}) {
  const { fullMeetingUtterances = [], history = [] } = options
  const latestClient = getClientText(latestUtterances, speakerMap)
  const fullClient = getClientText(fullMeetingUtterances, speakerMap)

  if (!latestClient && !fullClient) {
    return {
      askingPrice: false,
      askingFullSystem: false,
      priceAskCount: 0,
      readyToClose: false,
      askingCredibility: false,
      askingOwnership: false,
      askingOnboarding: false,
      askingCompetitor: false,
      portfolioObjection: false,
      askingProcess: false,
      askingTrust: false,
      askingFreeWork: false,
      clientStatedBudget: false,
      askingDeadline: false,
      askingWhereToStart: false,
      priceObjection: false,
      alreadyStatedPhaseOnePrice: false,
      portalFeatureAsked: false,
      citedClients: [],
      alreadyStatedDeadlinePitch: false,
      alreadyStatedAccountLead: false,
      clientRejectedTmsReplacement: false,
      askingWhatYouKnow: false,
      askingAboutCompany: false,
      askingIndustryExperience: false,
      logisticsContext: false,
      askingPortfolioNames: false,
      askingPortfolioDetails: false,
      askingTechnicalHow: false,
      askingSecurityCompliance: false,
    }
  }

  const meetingContextBlob = `${latestClient} ${fullClient}`

  const askingExperienceThisTurn = /\b(have you (?:actually )?(?:done|built|touch(?:ed)?|worked)|have you worked|worked on|do you have (?:any )?experience|experience (?:in|with|building)|worked in (our|this) space|similar (?:work|projects|types of companies)|past projects?|built (?:for|websites? for)|behavioral health|convince me|didn'?t see anything|nothing like (?:ours|that)|who did you (?:work|build)|for which ones|company names?|names? of (?:your )?(?:past )?(?:clients?|projects?|companies)|provide (?:some )?examples?|examples? of (?:projects?|work)|go into detail)\b/i.test(latestClient)

  const askingAiTraining = isAiTrainingQuestion(latestClient)

  const askingTechnicalHow = !askingAiTraining && (
    /\b(how (?:would|will|do)|how can|can your (?:platform|system)|architecture|scale|integrat|sync|webhook|sftp|ocr|inconsistenc|detect|automati|where does (?:that |the )?data|who can see|plug into|if .+ goes down|liable|misconfigur|as\/400|blockchain|realistic\?|what happens to|keep the data|without disrupting|double-entering|barcode|rfid|retool|chatgpt|tenant|upload|hallucinat|identify inconsistenc)\b/i.test(latestClient)
  ) && !askingExperienceThisTurn

  const askingSecurityCompliance = askingAiTraining
    || /\b(baa|soc 2|hipaa|phi|s3 bucket|encryption|iam|least-?privilege|data breach|session notes leak|compliance certif|counsel says|who(?:'s| is) liable|data privacy)\b/i.test(latestClient)

  const askingPrice = /\b(price|pricing|cost|quote|estimate|ballpark|how much|expense|fee|fees|what would we (?:actually )?get(?: for)?|what'?s a ballpark|capped us at|eight thousand dollars|can you do it for)\b/i.test(latestClient)
    && !/\bbudget line\b/i.test(latestClient)
    && !askingTechnicalHow
    && !/\b(inconsistency|appraisal says|catch that automatically|architecture scale)\b/i.test(latestClient)
    && (/\b(budget|capped|eight thousand|how much|ballpark|price|cost)\b/i.test(latestClient))

  const pricePattern = /\b(price|pricing|cost|budget|quote|estimate|ballpark|numbers?|how much|expense|fee|fees|estimated amount|give me an? (?:estimated )?amount)\b/gi
  const priceAskCount = (fullClient.match(pricePattern) || []).length

  const priorSay = extractSectionBodies(history, 'Say this next')
  const priorFollow = extractSectionBodies(history, 'Follow-up')
  const priorCoachingText = history
    .filter(h => h.role === 'assistant')
    .map(h => h.content || '')
    .join(' ')
    .toLowerCase()

  const alreadyPromisedProposal = /\b(24-48 hours|written (estimate|proposal)|detailed written estimate|send (it|the proposal|over)|by friday|provide a written)\b/i.test(priorCoachingText)

  const alreadyStatedPhaseOnePrice = /\bphase one is \$[\d,]+/i.test(priorCoachingText)
  const priceMentionCount = (priorCoachingText.match(/\$[\d,]+/g) || []).length

  const portalFeatureAsked = priorFollow.some(f =>
    /\b(features?|critical|envision|portal)\b/i.test(f)
  )

  const citedClients = [...priorCoachingText.matchAll(/\b(?:work with|similar to our) ([a-z][\w.\s]+?)(?:\s+project|\s*,)/gi)].map(m => m[1].trim())

  const alreadyStatedDeadlinePitch = /\b(mid-august|weekly demos?|deliver phase one by)\b/i.test(priorCoachingText)
  const alreadyStatedAccountLead = /\baccount lead\b/i.test(priorCoachingText)

  const budgetAmountMatch = latestClient.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/i)
    || fullClient.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/i)
  const statedBudgetPhrase = /\b(budget|capped us at|eight thousand|total budget|board capped|pay up to)\b/i.test(`${latestClient} ${fullClient}`)
    && !/\bbudget line\b/i.test(latestClient)
  const clientStatedBudget = statedBudgetPhrase && Boolean(budgetAmountMatch || /\beight thousand\b/i.test(`${latestClient} ${fullClient}`))

  const logisticsContext = /\b(trucking|logistics|freight|transportation|dispatch)\b/i.test(meetingContextBlob)
  const financeContext = /\b(lending|loan|mortgage|finance|fintech|borrower|appraisal|underwriting|real estate|real-estate|capital|dscr|fix-and-flip|bridge lending|construction lending|commercial real estate|draw request|los\b)\b/i.test(meetingContextBlob)
  const cannabisContext = /\b(cannabis|cultivat|metrc|dispensary|seed-to-sale)\b/i.test(meetingContextBlob)
  const healthcareContext = /\b(healthcare|health care|behavioral|hospice|patient|clinical|hipaa|phi)\b/i.test(meetingContextBlob)
  const nonprofitContext = /\b(church|parish|sermon|nonprofit|non-profit|donation)\b/i.test(meetingContextBlob)

  const industryInMeeting = logisticsContext || financeContext || cannabisContext || healthcareContext || nonprofitContext
    || /\b(trucking|logistics|freight|transportation|cannabis|cultivat|metrc|behavioral health|behavioral|lending|real estate|healthcare|church|parish|finance|mortgage|loan)\b/i.test(meetingContextBlob)

  const askingPortfolioNames = /\b(names? of|give me names?|company names?|can i ask for the|which (?:trucking|logistics|finance|lending|companies)|what (?:trucking|logistics|finance|lending) companies|who did you (?:work|build)|recently built websites? with|provide (?:some )?examples?|examples? of (?:projects?|work|past)|past projects?|similar projects?)\b/i.test(latestClient)
    && (industryInMeeting || /\b(names?|examples?|projects?|companies)\b/i.test(latestClient))
  const askingPortfolioDetails = /\b(what kind of (?:websites?|sites?)|features? (?:did you|you built)|built for (?:these|those)|tell me (?:more )?about (?:the )?(?:sites?|websites?|work|builds)|go into detail|detail on each|walk (?:me )?through (?:each|what you built))\b/i.test(latestClient)
    || (/\bfeatures?\b/i.test(latestClient) && /\b(these|those|companies)\b/i.test(latestClient))
    || (/\bgo into detail\b/i.test(latestClient) && askingExperienceThisTurn)

  const prospectOwnedPortfolio = isProspectOwnedPortfolioPhrase(latestClient)

  const askingIndustryExperience = !prospectOwnedPortfolio
    && !askingTechnicalHow
    && industryInMeeting
    && (askingExperienceThisTurn || askingPortfolioNames || askingPortfolioDetails)

  const askingAboutCompany = /\btell me (?:something )?about (?:my|our) company\b|\bsomething about (?:my|our) company\b|\bwhat (?:my|our) company does\b|\babout (?:my|our) company\b/i.test(latestClient)
  const askingWhatYouKnow = /\bwhat you know (?:about|so far)|tell me (?:about )?what you know|what do you know\b|\bwhat you think (?:my|our) company needs\b/i.test(latestClient)
    || askingAboutCompany
    || /\btell me\b.{0,80}\b(?:echo|company|what we do)\b/i.test(latestClient)

  return {
    askingPrice,
    priceAskCount,
    clientStatedBudget,
    clientBudgetText: budgetAmountMatch?.[0] || (/\beight thousand\b/i.test(latestClient) ? 'eight thousand dollars' : ''),
    askingFullSystem: /\b(all details|whole system|full system|entire system|what (will|would) (you |we )?build|complete (solution|system|platform)|walk me through|overview of|everything (you|we)('ll| will))\b/.test(latestClient),
    readyToClose: /\b(send it|copy\s+\w+|ready to move|if the numbers work|sounds good|let'?s (proceed|move forward)|we'?re ready)\b/i.test(latestClient),
    askingCredibility: askingExperienceThisTurn && !askingTechnicalHow,
    askingTechnicalHow,
    askingSecurityCompliance,
    askingOwnership: /\b(who owns|point of contact|single point|relationship|who do we work with)\b/i.test(latestClient),
    askingOnboarding: /\b(first two weeks|first 2 weeks|kickoff|what happens after (we )?sign|after we sign)\b/i.test(latestClient),
    askingCompetitor: /\b(other vendor|competing vendor|big[- ]bang|all[- ]in[- ]one contract|pricing is a bit higher|higher than|few vendors)\b/i.test(latestClient),
    priceObjection: /\b(higher than|more expensive|bit higher|expected to pay|cheaper)\b/i.test(latestClient),
    askingDeadline: /\b(before our|q[1-4]|launch in|deadline|by september|by october|in september|on time|deliver this before)\b/i.test(latestClient),
    askingWhereToStart: /\b(not sure where to start|where to start|don't know where to begin|how do we start)\b/i.test(latestClient),
    alreadyStatedPhaseOnePrice,
    priceMentionCount,
    portalFeatureAsked,
    citedClients,
    alreadyStatedDeadlinePitch,
    alreadyStatedAccountLead,
    portfolioObjection: /\b(didn'?t see|don'?t see|did not see|not see anything similar|nothing similar|nothing like (?:ours|that)|your portfolio (?:doesn'?t|does not|lacks|didn'?t)|(?:didn'?t|don'?t|did not) see (?:anything|much) in (?:your )?portfolio|not (?:convinced|sure) (?:about|by) (?:your )?portfolio)\b/i.test(latestClient),
    askingProcess: /\b(development process|start to finish|from the start|what does .+ look like)\b/i.test(latestClient),
    askingTrust: /\b(bad experience|missed deadlines|how can we trust|trust this|ghosted|how do i know you won'?t|promised the moon)\b/i.test(latestClient),
    askingFreeWork: /\b(free prototype|before we commit|in-house developer|outsourcing)\b/i.test(latestClient),
    clientRejectedTmsReplacement: /\b(that'?s never happening|never happening|won'?t replace|not replacing).{0,40}\b(tms|transportation management)\b|\b(tms|transportation management).{0,40}(never|not replacing|won'?t replace)/i.test(fullClient),
    askingWhatYouKnow,
    askingAboutCompany,
    askingIndustryExperience,
    logisticsContext,
    askingPortfolioNames,
    askingPortfolioDetails,
    alreadyPromisedProposal,
    latestClientText: latestClient,
  }
}

export function buildIntentGuidance(intent = {}) {
  const lines = []
  const clientAskedNewTopic = Boolean(
    intent.askingIndustryExperience
    || intent.askingCredibility
    || intent.askingPortfolioNames
    || intent.askingPortfolioDetails
    || intent.askingWhatYouKnow
    || intent.askingPrice
    || intent.askingOwnership
    || intent.askingTrust
    || intent.askingProcess
    || intent.askingDeadline
    || intent.portfolioObjection
    || intent.askingTechnicalHow
    || intent.askingSecurityCompliance
  )

  if (intent.askingTechnicalHow) {
    lines.push(`**PRIORITY — technical "how" question.** Answer with architecture only: name specific technologies (S3, Postgres, REST, webhooks, OCR, rules engine, SFTP, idempotent sync). Do NOT name any past client. Do NOT give pricing unless they explicitly asked for price this turn. Do NOT describe unrelated portfolio work (e.g. trucking/freight builds). **What they're asking:** must describe THIS technical question only — not lending experience or past projects.`)
  }

  if (isAiTrainingQuestion(intent.latestClientText || '')) {
    lines.push(`**PRIORITY — AI training / data privacy.** Say this next MUST answer no — customer data is never used to train public models. Mention enterprise API zero-retention and contract language. Do NOT describe OCR, rules engine, or document inconsistency checks.`)
  } else if (intent.askingSecurityCompliance) {
    lines.push(`**PRIORITY — security/compliance.** Answer with BAA, HIPAA, encryption at rest, bucket policies, least-privilege IAM, and shared responsibility. Do NOT repeat a prior turn verbatim. Do NOT name past clients unless they asked about experience.`)
  }

  if (intent.askingPortfolioDetails) {
    lines.push(`**PRIORITY — client asked what we built and the features.** Name each past client from ALLOWED PAST CLIENT NAMES with website type and 2-3 features from RELEVANT PAST WORK project summaries. No timeline or budget questions.`)
  } else if (intent.askingPortfolioNames) {
    lines.push(`**PRIORITY — client asked for past project names or examples.** List 2-3 client names from ALLOWED PAST CLIENT NAMES only — same industry as the prospect. One short clause per name from RELEVANT PAST WORK summaries. No generic "comparable builds" without names.`)
  } else if (intent.askingIndustryExperience) {
    lines.push(`**PRIORITY — client asked about industry experience.** Say this next MUST answer yes and name exactly 2 past clients from ALLOWED PAST CLIENT NAMES with scope from RELEVANT PAST WORK — same industry as the prospect. Do NOT ask about timeline, budget, SOW, or decision-maker this turn.`)
  } else if (intent.askingCredibility && !intent.askingTechnicalHow) {
    lines.push(`**PRIORITY — client asked about industry experience.** Say this next MUST name 2 past clients from ALLOWED PAST CLIENT NAMES with scope — same industry as the prospect. Do NOT pivot to timeline, budget, or closing questions.`)
  }

  if (intent.askingWhatYouKnow) {
    lines.push(`**Client asked what you know about them.** Use MEETING BRIEF prep notes and website only — max 2 short sentences. Put discovery questions in Follow-up only, not in Say this next. NEVER say "I can't provide details about your company".`)
  }

  if (intent.clientRejectedTmsReplacement) {
    lines.push(`**Client will NOT replace their TMS.** Do NOT pitch TMS replacement, ask timeline for a new TMS, or cite portfolio TMS projects as the prospect's stack. Focus on integrations/automations across the systems THEY named (e.g. Macleod, QuickBooks, HubSpot, Outlook).`)
  }

  if (intent.alreadyStatedPhaseOnePrice && !intent.askingPrice) {
    lines.push(`**Price already given.** Do NOT restate phase-one dollar amount or repeat the same spreadsheet comparable. Answer ONLY the client's new concern in this turn.`)
  }

  if (intent.portalFeatureAsked && !clientAskedNewTopic) {
    lines.push(`**Feature-priority question already asked.** Do NOT ask "what features are critical" again. Ask kickoff date, who signs the SOW, or budget alignment instead.`)
  }

  if (intent.citedClients?.length) {
    lines.push(`**Past clients already cited:** ${intent.citedClients.join(', ')}. Use a DIFFERENT name from ALLOWED PAST CLIENT NAMES or skip the citation.`)
  }

  if (intent.priceObjection) {
    lines.push(`**Price objection.** Cheaper vendors usually split QA/integration into later phases. State what phase one includes vs what gets cut. Name a healthcare comparable ONLY — never finance/trucking/logistics. No closing meta sentence about "phased approach" or "reducing risk".`)
  }

  if (intent.askingDeadline && intent.alreadyStatedDeadlinePitch) {
    lines.push(`**Deadline already addressed.** Add a new fact only — e.g. testing buffer, milestone date, or contract language.`)
  } else if (intent.askingDeadline) {
    lines.push(`**Deadline concern.** Name a concrete go-live date before their stated launch (e.g. August for September Q3). Weekly demos + fixed dates in contract. No price repeat unless they asked again.`)
  }

  if (intent.askingWhereToStart) {
    lines.push(`**Client unsure where to start.** Three steps only: (1) lock phase-one modules in SOW, (2) week-one kickoff with their in-house dev, (3) wireframes before build. Name first deliverable.`)
  }

  if (intent.readyToClose) {
    lines.push(`**CLOSE MODE — client agreed to move forward.** Do NOT ask more scoping or feature questions. Coach You to: (1) confirm proposal delivery date, (2) confirm email recipients, (3) list what the document includes (scope, timeline, pricing structure), (4) propose a short review call to sign. Keep it short.`)
  }

  if (intent.askingCompetitor) {
    lines.push(`**Client compared us to a big-bang competitor.** Contrast phased go-live vs monolith. Name phase-one modules already discussed. Tie to their deadline (e.g. peak season).`)
  }

  if (intent.portfolioObjection) {
    lines.push(`**Client doubts portfolio fit.** Name 2 past clients from ALLOWED PAST CLIENT NAMES in the SAME INDUSTRY as the prospect with comparable scope. Explain why the build is comparable. Do NOT repeat the same past client cited in prior coaching. Never cite unrelated industries (e.g. cannabis or hospice for a finance/lending prospect).`)
  }

  if (intent.askingTrust) {
    lines.push(`**Client has vendor trust concerns.** Do NOT repeat the deadline or weekly-demo pitch if already stated. Coach You on: (1) locked scope in SOW — no surprise add-ons, (2) named milestones with dates in the contract, (3) what happens if a milestone slips (credit, finish at no extra cost, or escalation to You). One healthcare comparable from the sheet only if industry matches.`)
    if (intent.alreadyStatedDeadlinePitch) {
      lines.push(`**Deadline pitch already given.** Trust answer must be milestones + contract terms only — not mid-August or weekly demos again.`)
    }
    if (intent.alreadyStatedAccountLead) {
      lines.push(`**Account lead already stated.** Do not say "I'll be your account lead" again.`)
    }
  }

  if (intent.askingProcess) {
    lines.push(`**Client asked for end-to-end process.** Give kickoff → design/wireframes → build → QA → launch in plain steps. Tie to their deadline (use the LATEST deadline they stated in the transcript). Do NOT ask another feature-priority question.`)
  }

  if (intent.askingFreeWork) {
    lines.push(`**Client asked for free prototype or compared to in-house hire.** Decline free build clearly; offer paid discovery, wireframes, or fixed phase-one SOW instead. Explain why agency de-risks deadline vs one in-house dev.`)
  }

  if (intent.clientStatedBudget && intent.clientBudgetText) {
    lines.push(`**Client stated budget: ${intent.clientBudgetText}.** Acknowledge THEIR number and map phase-one scope to it. State a concrete dollar range in "Say this next" using ESTIMATED PRICE GUIDANCE and spreadsheet comparables.`)
  }

  if (intent.askingOwnership) {
    lines.push(`**Client asked who owns the relationship.** Coach You to name themselves as account lead and mention delivery/PM support in week one.`)
  }

  if (intent.askingOnboarding) {
    lines.push(`**Client asked about first two weeks.** Give concrete week-one (kickoff, workflow mapping, access) and week-two (milestone plan, written scope for finance) agenda.`)
  }

  if (intent.askingFullSystem) {
    lines.push(`**Client wants the full system picture.** Tight 4-6 module spoken summary of ONE unified platform already discussed. Do not pitch a new tool.`)
  }

  if (intent.askingPrice) {
    lines.push(`**Client asked for price / estimate / budget.** You MUST state dollar amounts out loud using ESTIMATED PRICE GUIDANCE from the spreadsheet. Use RECOMMENDED PHASE-ONE ESTIMATE if provided. Name the comparable past project from the sheet that supports the number. Break down what is included in phase one at that price.`)
    if (intent.priceAskCount >= 2 || intent.alreadyPromisedProposal) {
      lines.push(`**Client pressed on pricing again.** Do NOT repeat "proposal in 24-48 hours". Give the spreadsheet-backed dollar range again and explain what finance gets on paper.`)
    }
  }

  if (lines.length) {
    lines.push(`**Anti-repeat:** New past client name only. No repeated deferrals. Follow-up must be a question not already asked.`)
  }

  return lines.length ? `\n\nIntent for this moment:\n${lines.join('\n')}` : ''
}
