const PRICE_IN_TEXT = /\$[\d,]+(?:\.\d{2})?(?:\s*[-–—to]+\s*\$[\d,]+(?:\.\d{2})?)?|\b\d{1,3}k\b/gi
const DURATION_IN_TEXT = /\b\d{1,2}[-–—to]\d{1,2}\s*(?:weeks|months)\b|\b\d+\s*(?:weeks|months)\b/gi
const PHASE_IN_TEXT = /\bphase\s*(?:one|two|1|2|i|ii)\b/gi

const INDUSTRY_KEYWORDS = [
  'logistics', 'transportation', 'transport', 'dispatch', 'healthcare', 'finance',
  'ecommerce', 'retail', 'construction', 'education', 'legal', 'automotive',
  'agriculture', 'energy', 'insurance', 'government', 'defense', 'food',
]

const SCOPE_WEIGHT = {
  'web design': 1,
  'web application': 2,
  'app development': 2,
  'software development': 3,
  'enterprise platform': 4,
  'saas': 4,
  'ai': 3,
  'integration': 2,
}

export function getKnowledgeCompanyNames(knowledge = []) {
  return [...new Set(
    knowledge
      .map(row => row.companyName?.trim())
      .filter(Boolean)
  )]
}

function tokenize(text = '') {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 3)
}

function getScopeWeight(scope = '') {
  const lower = scope.toLowerCase()
  let weight = 1
  for (const [label, value] of Object.entries(SCOPE_WEIGHT)) {
    if (lower.includes(label)) weight = Math.max(weight, value)
  }
  return weight
}

function parsePriceToken(token = '') {
  const t = token.toLowerCase().replace(/,/g, '')
  const kMatch = t.match(/(\d+(?:\.\d+)?)\s*k\b/)
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000)

  const dollarMatches = [...t.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)]
  if (!dollarMatches.length) return null
  return Math.round(parseFloat(dollarMatches[0][1]))
}

function parsePriceRangeFromStrings(priceStrings = []) {
  const values = []

  for (const raw of priceStrings) {
    const range = raw.match(/\$?([\d,]+(?:\.\d+)?)\s*(?:k\b|[-–—to]+\s*\$?([\d,]+(?:\.\d+)?))/i)
    if (range) {
      const first = parsePriceToken(range[1] + (raw.toLowerCase().includes('k') && !range[2] ? 'k' : ''))
      const second = range[2] ? parsePriceToken(range[2]) : null
      if (first) values.push(first)
      if (second) values.push(second)
      continue
    }

    const single = parsePriceToken(raw)
    if (single) values.push(single)
  }

  if (!values.length) return null
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    values,
  }
}

function formatUsd(amount) {
  return `$${amount.toLocaleString('en-US')}`
}

function formatUsdRange(min, max) {
  if (min === max) return formatUsd(min)
  return `${formatUsd(min)} – ${formatUsd(max)}`
}

export function collectSheetPriceCatalog(knowledge = []) {
  return knowledge
    .map(row => {
      const blob = [
        row.companyName,
        row.scopeOfServices,
        row.projectName,
        row.industry,
        row.techStack,
        row.projectSummary,
        row.link,
        row.workedUnderPrime,
        row.owner,
      ].filter(Boolean).join(' ')

      const priceStrings = [...(blob.match(PRICE_IN_TEXT) || [])]
      const range = parsePriceRangeFromStrings(priceStrings)

      return {
        row,
        priceStrings,
        range,
        weight: getScopeWeight(row.scopeOfServices || ''),
      }
    })
    .filter(entry => entry.priceStrings.length > 0)
}

export function buildPriceEstimateSection(knowledge = [], relevantProjects = [], contextText = '') {
  if (!knowledge.length) return ''

  const catalog = collectSheetPriceCatalog(knowledge)
  const comparables = relevantProjects.length ? relevantProjects : knowledge.slice(0, 5)
  const targetWeight = getScopeWeight(comparables[0]?.scopeOfServices || 'web application')

  const comparableEntries = comparables.map(row => {
    const entry = catalog.find(item => item.row.companyName === row.companyName)
    return { row, entry }
  })

  const pricedFromComparable = comparableEntries.find(item => item.entry?.range)
  const pricedFromTier = catalog.find(item => Math.abs(item.weight - targetWeight) <= 1)
  const pricedCatalogEntry = pricedFromComparable?.entry || pricedFromTier || catalog[0]
  const pricedRow = pricedFromComparable?.row || pricedCatalogEntry?.row

  const tierPeers = catalog.filter(item => Math.abs(item.weight - targetWeight) <= 1)
  const tierValues = tierPeers.flatMap(item => item.range?.values || [])

  const clientBudgetMatch = contextText.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/i)
  const clientRange = clientBudgetMatch
    ? parsePriceRangeFromStrings([clientBudgetMatch[0]])
    : null

  let tierRange = null
  if (tierValues.length) {
    tierRange = {
      min: Math.min(...tierValues),
      max: Math.max(...tierValues),
    }
  }

  const lines = [
    'ESTIMATED PRICE GUIDANCE (from spreadsheet — when client asks for price, Boss MUST state these dollar amounts out loud):',
  ]

  if (pricedCatalogEntry?.range && pricedRow) {
    lines.push(
      `Closest priced comparable: ${pricedRow.companyName} | ${pricedRow.scopeOfServices || 'project'} | documented ${pricedCatalogEntry.priceStrings.join(', ')}`
    )
    lines.push(`Comparable project range: ${formatUsdRange(pricedCatalogEntry.range.min, pricedCatalogEntry.range.max)}`)
  }

  if (tierRange) {
    const peerNames = tierPeers.slice(0, 4).map(item => item.row.companyName).join(', ')
    lines.push(
      `Scope-tier benchmark (${comparables[0]?.scopeOfServices || 'similar scope'}): ${formatUsdRange(tierRange.min, tierRange.max)} from portfolio projects${peerNames ? ` (${peerNames})` : ''}`
    )
  }

  let recommendedMin = null
  let recommendedMax = null

  if (clientRange) {
    recommendedMin = clientRange.min
    recommendedMax = clientRange.max
    lines.push(`Client stated budget: ${formatUsdRange(clientRange.min, clientRange.max)}`)
  } else if (pricedCatalogEntry?.range) {
    recommendedMin = pricedCatalogEntry.range.min
    recommendedMax = pricedCatalogEntry.range.max
  } else if (tierRange) {
    recommendedMin = tierRange.min
    recommendedMax = tierRange.max
  }

  if (recommendedMin != null && recommendedMax != null) {
    lines.push(
      `RECOMMENDED PHASE-ONE ESTIMATE TO STATE NOW: ${formatUsdRange(recommendedMin, recommendedMax)} — tie to phase-one scope discussed in this meeting and name the spreadsheet comparable used.`
    )
    lines.push(
      'Pricing rule: State this dollar range in "Say this next". Do NOT dodge with "I\'ll send a written estimate later" unless Boss already promised one twice. Explain what is included in phase one vs phase two at this price.'
    )
  } else {
    lines.push(
      'No dollar amounts found in spreadsheet rows for this scope tier. Add typical project fees to the "All Work" tab summaries, or use the client\'s stated budget if they gave one. Until then, name the closest comparable scope from the sheet and describe module-based pricing structure.'
    )
  }

  if (catalog.length) {
    lines.push('\nAll documented prices in spreadsheet:')
    for (const item of catalog.slice(0, 12)) {
      lines.push(`- ${item.row.companyName} | ${item.row.scopeOfServices || 'project'}: ${item.priceStrings.join(', ')}`)
    }
  }

  return lines.join('\n')
}

export function getAllowedSheetPrices(knowledge = [], relevantProjects = [], contextText = '') {
  const allowed = new Set()
  const catalog = collectSheetPriceCatalog(knowledge)

  for (const item of catalog) {
    item.priceStrings.forEach(price => allowed.add(price))
    if (item.range) {
      allowed.add(formatUsd(item.range.min))
      allowed.add(formatUsd(item.range.max))
      allowed.add(formatUsdRange(item.range.min, item.range.max))
    }
  }

  const estimateBlock = buildPriceEstimateSection(knowledge, relevantProjects, contextText)
  const recommended = estimateBlock.match(/RECOMMENDED PHASE-ONE ESTIMATE TO STATE NOW:\s*(\$[\d,]+(?:\s*[–-]\s*\$[\d,]+)?)/i)
  if (recommended?.[1]) allowed.add(recommended[1])

  const clientPrices = contextText.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/gi) || []
  clientPrices.forEach(price => allowed.add(price))

  return [...allowed]
}

function extractRowSignals(row) {
  const blob = [
    row.companyName,
    row.scopeOfServices,
    row.projectName,
    row.industry,
    row.techStack,
    row.projectSummary,
    row.link,
    row.workedUnderPrime,
    row.owner,
  ].filter(Boolean).join(' ')

  const prices = [...(blob.match(PRICE_IN_TEXT) || [])]
  const durations = [...(blob.match(DURATION_IN_TEXT) || [])]
  const phases = [...(blob.match(PHASE_IN_TEXT) || [])]
  return { prices, durations, phases }
}

const PROSPECT_INDUSTRY_KEYWORDS = {
  healthcare: ['healthcare', 'health', 'patient', 'medical', 'clinical', 'hospital', 'pharma'],
  logistics: ['logistics', 'transportation', 'transport', 'dispatch', 'trucking', 'freight'],
  finance: ['finance', 'fintech', 'banking', 'insurance'],
  ecommerce: ['ecommerce', 'e-commerce', 'retail', 'shop'],
}

function detectProspectIndustries(contextText = '') {
  const lower = contextText.toLowerCase()
  const matches = []
  for (const [industry, keywords] of Object.entries(PROSPECT_INDUSTRY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) matches.push(industry)
  }
  return matches
}

function rowIndustryBucket(row) {
  const blob = [row.industry, row.projectSummary, row.scopeOfServices].join(' ').toLowerCase()
  for (const [industry, keywords] of Object.entries(PROSPECT_INDUSTRY_KEYWORDS)) {
    if (keywords.some(k => blob.includes(k))) return industry
  }
  return null
}

export function scoreProjectRelevance(row, contextTokens, brief = {}, contextText = '') {
  let score = 0
  const fields = [
    row.companyName,
    row.scopeOfServices,
    row.industry,
    row.techStack,
    row.projectSummary,
  ].join(' ').toLowerCase()

  for (const token of contextTokens) {
    if (fields.includes(token)) score += 2
  }

  const prospectIndustries = detectProspectIndustries(`${contextText} ${brief?.background || ''}`)
  const rowBucket = rowIndustryBucket(row)

  if (prospectIndustries.length && rowBucket) {
    if (prospectIndustries.includes(rowBucket)) score += 12
    else score -= 8
  }

  for (const keyword of INDUSTRY_KEYWORDS) {
    if (fields.includes(keyword) && contextTokens.some(t => t.includes(keyword) || keyword.includes(t))) {
      score += 3
    }
  }

  if (brief.clientCompany && fields.includes(brief.clientCompany.toLowerCase())) {
    score += 5
  }

  if (brief.background) {
    for (const token of tokenize(brief.background)) {
      if (fields.includes(token)) score += 1
    }
  }

  return score
}

export function findRelevantProjects(knowledge = [], contextText = '', brief = {}, limit = 8) {
  const contextTokens = tokenize(contextText)
  if (!knowledge.length) return []

  const scored = knowledge
    .map(row => ({ row, score: scoreProjectRelevance(row, contextTokens, brief, contextText) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)

  const picks = scored.slice(0, limit).map(item => item.row)
  if (picks.length > 0) return picks

  return knowledge.slice(0, Math.min(limit, 5))
}

export function buildPricingTiers(knowledge = []) {
  const tiers = { light: [], medium: [], heavy: [] }

  for (const row of knowledge) {
    const weight = getScopeWeight(row.scopeOfServices || '')
    const signals = extractRowSignals(row)
    const entry = { row, signals, weight }
    if (weight <= 1) tiers.light.push(entry)
    else if (weight <= 2) tiers.medium.push(entry)
    else tiers.heavy.push(entry)
  }

  return tiers
}

function formatComparableLine(row, signals) {
  const parts = [
    row.companyName,
    row.scopeOfServices,
    row.industry,
  ].filter(Boolean)

  const line = [`- ${parts.join(' | ')}`]
  if (row.techStack) line.push(`  Stack: ${row.techStack}`)
  if (signals.prices.length) line.push(`  Documented pricing signal: ${signals.prices.join(', ')}`)
  if (signals.durations.length) line.push(`  Documented timeline signal: ${signals.durations.join(', ')}`)
  if (signals.phases.length) line.push(`  Delivery shape: ${signals.phases.join(', ')}`)
  if (row.projectSummary) {
    const short = row.projectSummary.length > 160
      ? `${row.projectSummary.slice(0, 160)}...`
      : row.projectSummary
    line.push(`  Scope: ${short}`)
  }
  return line.join('\n')
}

export function buildRelevantKnowledgeSection(relevantProjects = []) {
  if (!relevantProjects.length) return ''

  const lines = relevantProjects.map(row => {
    const signals = extractRowSignals(row)
    return formatComparableLine(row, signals)
  })

  const allowedNames = getKnowledgeCompanyNames(relevantProjects)

  return `RELEVANT PAST WORK (from spreadsheet — cite ONLY these when naming past clients):
${lines.join('\n\n')}

ALLOWED PAST CLIENT NAMES (never cite any name not on this list):
${allowedNames.join(', ')}`
}

export function buildPricingBasisSection(knowledge = [], relevantProjects = [], meetingContext = '') {
  if (!knowledge.length) return ''

  const comparables = (relevantProjects.length ? relevantProjects : knowledge.slice(0, 5))
    .map(row => ({ row, signals: extractRowSignals(row), weight: getScopeWeight(row.scopeOfServices || '') }))

  const withPriceSignals = comparables.filter(c => c.signals.prices.length > 0)
  const withTimelineSignals = comparables.filter(c => c.signals.durations.length > 0 || c.signals.phases.length > 0)

  const tiers = buildPricingTiers(knowledge)
  const tierSummary = [
    tiers.light.length && `lighter scopes (${tiers.light.length} past projects: web design, smaller builds)`,
    tiers.medium.length && `mid scopes (${tiers.medium.length} past projects: web apps, mobile apps)`,
    tiers.heavy.length && `heavier scopes (${tiers.heavy.length} past projects: enterprise, SaaS, multi-module platforms)`,
  ].filter(Boolean).join('; ')

  const comparableBlock = comparables
    .slice(0, 5)
    .map(({ row, signals }) => formatComparableLine(row, signals))
    .join('\n\n')

  return `PRICING & SCOPE BASIS (from spreadsheet — use this instead of inventing numbers or client names):
Portfolio shape: ${tierSummary || 'use scope-of-services column to compare complexity'}.

Closest comparable past projects for THIS conversation:
${comparableBlock}

Pricing rules tied to spreadsheet data:
- When client asks for price, estimate, budget, or ballpark: state dollar amounts from ESTIMATED PRICE GUIDANCE above. Boss must say the prices out loud.
- Use the RECOMMENDED PHASE-ONE ESTIMATE range when provided. Anchor it to the named spreadsheet comparable project and phase-one scope.
- You may also use documented pricing signals and scope-tier benchmarks from comparable rows.
- If client stated their own budget, align phase-one estimate to that range when it matches the comparable scope tier.
- Never invent prices that are not supported by spreadsheet documented prices, scope-tier benchmarks, or the client's stated budget.
- Never cite a past client company unless it appears in ALLOWED PAST CLIENT NAMES.
${withPriceSignals.length ? '' : '\nNote: Few explicit dollar amounts in comparable rows — use scope-tier benchmark and client budget from ESTIMATED PRICE GUIDANCE.'}
${meetingContext.includes('october') || meetingContext.includes('peak') ? 'Client has a hard seasonal deadline — tie phase-one timeline to that date using documented timeline signals when available.' : ''}`
}

export function buildAllowedNamesSection(knowledge = [], clientCompany = '') {
  const names = getKnowledgeCompanyNames(knowledge)
  if (!names.length && !clientCompany) return ''

  const list = [...names]
  if (clientCompany && !list.includes(clientCompany)) list.unshift(`${clientCompany} (prospect — not a past client)`)

  return `CITATION WHITELIST:
Past client names you may reference: ${names.join(', ') || 'none loaded'}.
Prospect on this call: ${clientCompany || 'unknown'}.`
}
