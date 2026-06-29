const PRICE_IN_TEXT = /\$[\d,]+(?:\.\d{2})?(?:\s*[-–—to]+\s*\$[\d,]+(?:\.\d{2})?)?|\b\d{1,3}k\b/gi
const MIN_DOCUMENTED_PROJECT_PRICE = 500
const NON_PROJECT_PRICE_CONTEXT = /\$?\d[\d,]*\s*(?:perk|perks|off\b|discount|coupon|cash back|tip|redeem|subscription|monthly|\/month|per month|per user|per seat|shipping|delivery fee)/i
const PROJECT_PRICE_CONTEXT = /\b(?:budget|cost|price|priced|fee|fees|estimate|quoted|investment|range|phase[- ]?(?:one|1)|total|project)\b/i
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

export function buildRowPricingBlob(row = {}) {
  return [
    row.companyName,
    row.scopeOfServices,
    row.projectName,
    row.industry,
    row.techStack,
    row.projectSummary,
    row.notes,
    row.signedContractLink,
    row.link,
    row.workedUnderPrime,
    row.owner,
  ].filter(Boolean).join(' ')
}

function parseMonthlyContractPricing(blob = '') {
  const monthlyMatch = blob.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*(?:mo|month)|\/\s*(?:mo|month)|a\s+month)/i)
  if (!monthlyMatch) return null

  const monthlyRate = Math.round(parseFloat(monthlyMatch[1].replace(/,/g, '')))
  if (!monthlyRate || monthlyRate < MIN_DOCUMENTED_PROJECT_PRICE) return null

  const monthsMatch = blob.match(/(\d{1,2})\s*mo(?:nths?)?\b/i)
  const contractMonths = monthsMatch ? parseInt(monthsMatch[1], 10) : null

  return {
    monthlyRate,
    contractMonths,
    contractTotal: contractMonths ? monthlyRate * contractMonths : null,
    phaseOneMin: monthlyRate * 3,
    phaseOneMax: monthlyRate * 4,
  }
}

function isLikelyProjectFee(match, contextWindow = '') {
  if (NON_PROJECT_PRICE_CONTEXT.test(contextWindow)) return false

  if (/\d{1,3}k\b/i.test(match)) return true
  if (/\$[\d,]{4,}/.test(match)) return true

  const amount = parsePriceToken(match)
  if (!amount || amount < MIN_DOCUMENTED_PROJECT_PRICE) return false
  if (amount >= 1000) return true

  return PROJECT_PRICE_CONTEXT.test(contextWindow)
}

function extractProjectPrices(blob = '') {
  const prices = []
  const pattern = /\$[\d,]+(?:\.\d{2})?(?:\s*[-–—to]+\s*\$[\d,]+(?:\.\d{2})?)?|\b\d{1,3}k\b/gi
  let match
  while ((match = pattern.exec(blob)) !== null) {
    const token = match[0]
    const start = Math.max(0, match.index - 50)
    const end = Math.min(blob.length, match.index + token.length + 50)
    const context = blob.slice(start, end)
    if (isLikelyProjectFee(token, context)) prices.push(token)
  }
  return prices
}

export function collectSheetPriceCatalog(knowledge = []) {
  const seen = new Set()

  return knowledge
    .map(row => {
      const blob = buildRowPricingBlob(row)
      const monthly = parseMonthlyContractPricing(blob)
      const priceStrings = extractProjectPrices(blob)

      if (monthly) {
        priceStrings.push(`${formatUsd(monthly.monthlyRate)}/month`)
        priceStrings.push(formatUsdRange(monthly.phaseOneMin, monthly.phaseOneMax))
        if (monthly.contractTotal) priceStrings.push(formatUsd(monthly.contractTotal))
      }

      let range = parsePriceRangeFromStrings(priceStrings)
      if (monthly) {
        range = {
          min: monthly.phaseOneMin,
          max: monthly.phaseOneMax,
          values: [
            monthly.monthlyRate,
            monthly.phaseOneMin,
            monthly.phaseOneMax,
            monthly.contractTotal,
          ].filter(Boolean),
        }
      }

      return {
        row,
        blob,
        priceStrings: [...new Set(priceStrings)],
        range,
        monthly,
        weight: getScopeWeight(row.scopeOfServices || ''),
      }
    })
    .filter(entry => {
      const key = entry.row.companyName?.trim().toLowerCase()
      if (!key || !entry.priceStrings.length || seen.has(key)) return false
      seen.add(key)
      return true
    })
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
    'ESTIMATED PRICE GUIDANCE (from spreadsheet — when client asks for price, You MUST state these dollar amounts out loud):',
  ]

  if (pricedCatalogEntry?.range && pricedRow) {
    lines.push(
      `Closest priced comparable: ${pricedRow.companyName} | ${pricedRow.scopeOfServices || 'project'} | documented ${pricedCatalogEntry.priceStrings.join(', ')}`
    )
    if (pricedCatalogEntry.monthly) {
      lines.push(
        `Documented contract rate: ${formatUsd(pricedCatalogEntry.monthly.monthlyRate)}/month${pricedCatalogEntry.monthly.contractMonths ? ` (${pricedCatalogEntry.monthly.contractMonths}-month contract` + (pricedCatalogEntry.monthly.contractTotal ? `, ${formatUsd(pricedCatalogEntry.monthly.contractTotal)} total)` : ')') : ''}`
      )
      lines.push(
        `Phase-one budget at documented rate (3–4 months): ${formatUsdRange(pricedCatalogEntry.monthly.phaseOneMin, pricedCatalogEntry.monthly.phaseOneMax)}`
      )
    } else {
      lines.push(`Comparable project range: ${formatUsdRange(pricedCatalogEntry.range.min, pricedCatalogEntry.range.max)}`)
    }
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
      'Pricing rule: State this dollar range in "Say this next". Do NOT dodge with "I\'ll send a written estimate later" unless You already promised one twice. Explain what is included in phase one vs phase two at this price.'
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

export function getRecommendedPriceEstimate(knowledge = [], relevantProjects = [], contextText = '') {
  const block = buildPriceEstimateSection(knowledge, relevantProjects, contextText)
  if (/No dollar amounts found/i.test(block)) return null

  const rangeMatch = block.match(/RECOMMENDED PHASE-ONE ESTIMATE TO STATE NOW:\s*(\$[\d,]+(?:\s*[–-]\s*\$[\d,]+)?)/i)
  if (!rangeMatch) return null

  const comparableMatch = block.match(/Closest priced comparable:\s*([^|\n]+)\s*\|\s*([^|\n]+)/i)
  const monthlyMatch = block.match(/Documented contract rate:\s*(\$[\d,]+\/month)/i)
  const contractTotalMatch = block.match(/(\$[\d,]+ total)/i)

  return {
    rangeText: rangeMatch[1].trim(),
    comparableName: comparableMatch?.[1]?.trim() || '',
    comparableScope: comparableMatch?.[2]?.trim() || '',
    monthlyRateText: monthlyMatch?.[1]?.trim() || '',
    contractTotalText: contractTotalMatch?.[1]?.trim() || '',
  }
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
    if (item.monthly) {
      allowed.add(formatUsd(item.monthly.monthlyRate))
      allowed.add(`${formatUsd(item.monthly.monthlyRate)}/month`)
      if (item.monthly.contractTotal) allowed.add(formatUsd(item.monthly.contractTotal))
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
  const blob = buildRowPricingBlob(row)

  const prices = extractProjectPrices(blob)
  const durations = [...(blob.match(DURATION_IN_TEXT) || [])]
  const phases = [...(blob.match(PHASE_IN_TEXT) || [])]
  return { prices, durations, phases }
}

const PROSPECT_INDUSTRY_KEYWORDS = {
  healthcare: ['healthcare', 'health', 'patient', 'medical', 'clinical', 'hospital', 'pharma', 'behavioral', 'psychiatry', 'telehealth', 'phi'],
  logistics: ['logistics', 'transportation', 'transport', 'dispatch', 'trucking', 'freight'],
  finance: ['finance', 'fintech', 'banking', 'insurance', 'lending', 'lender', 'loan', 'mortgage', 'borrower', 'escrow', 'appraisal', 'underwriting', 'real estate', 'real-estate', 'capital', 'dscr', 'fix-and-flip', 'bridge lending', 'construction lending', 'commercial real estate', 'draw request'],
  ecommerce: ['ecommerce', 'e-commerce', 'retail', 'shop'],
  cannabis: ['cannabis', 'cultivat', 'metrc', 'dispensary', 'seed-to-sale'],
  nonprofit: ['church', 'parish', 'sermon', 'nonprofit', 'non-profit', 'donation'],
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

export function findIndustryProjects(knowledge = [], industry = 'logistics', limit = 2) {
  return knowledge
    .filter(row => rowIndustryBucket(row) === industry)
    .slice(0, limit)
}

const LENDING_PORTFOLIO_SIGNALS = /\b(lending|loan|mortgage|appraisal|underwriting|borrower|title report|draw request|document hub|loan doc|rules engine|escrow|dscr|fix-and-flip|bridge loan|commercial real estate|real estate lending|construction lending)\b/i
const RAW_NOTES_PATTERN = /^build a\b|^we need to\b|microsoft stack.*azure|works in conjunction|build an mobile/i
const AGRICULTURE_SIGNALS = /\b(grain|agriculture|farm|crop|elevator)\b/i

function dedupeProjectsByCompany(projects = [], limit = 2) {
  const seen = new Set()
  const out = []
  for (const row of projects) {
    const name = row?.companyName?.trim().toLowerCase()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

function isRawNotesText(text = '') {
  const t = text.trim()
  if (!t) return true
  if (t.length > 95) return true
  return RAW_NOTES_PATTERN.test(t)
}

function cleanProjectNameLabel(projectName = '', scopeOfServices = '') {
  const name = projectName.trim()
  if (!name) return ''
  const stripped = name.replace(/^[^-]+-\s*(web design|web application|software development|app development|mobile app development|integration)\s*$/i, '').trim()
  if (stripped && stripped.length <= 60 && stripped !== name) return stripped
  if (name.length <= 60 && !/-\s*(web design|web application|software development)/i.test(name)) return name
  return ''
}

export function isLendingPortfolioRow(row = {}) {
  const blob = [row.industry, row.projectSummary, row.scopeOfServices, row.projectName, row.companyName].join(' ')
  if (AGRICULTURE_SIGNALS.test(blob) && !LENDING_PORTFOLIO_SIGNALS.test(blob)) return false
  return LENDING_PORTFOLIO_SIGNALS.test(blob) || /\b(finance|lending|mortgage|real estate)\b/i.test(row.industry || '')
}

export function findFinanceLendingProjects(knowledge = [], { limit = 2, excludeNames = [] } = {}) {
  const exclude = new Set(excludeNames.map(n => n.trim().toLowerCase()).filter(Boolean))

  return dedupeProjectsByCompany(
    knowledge
      .filter(row => row.companyName?.trim() && !exclude.has(row.companyName.trim().toLowerCase()))
      .filter(isLendingPortfolioRow)
      .sort((a, b) => {
        const score = (row) => {
          const blob = [row.projectSummary, row.scopeOfServices, row.industry].join(' ').toLowerCase()
          let s = 0
          if (/\bocr|rules engine|document|appraisal|loan\b/.test(blob)) s += 4
          if (/\blending|mortgage|underwriting\b/.test(blob)) s += 3
          return s
        }
        return score(b) - score(a)
      }),
    limit,
  )
}
const TRUCKING_SIGNALS = /\b(truck|trailer|freight|logistics|dispatch|transport|carrier|hauling|shipping)\b/i
const WEB_SCOPE_SIGNALS = /\b(web\s*design|website|web\s*application|web\s*app|portal|landing\s*page)\b/i
const SERVICE_TYPE_LIST = /\b(web design|web application|software development|app development|mobile app development|integration)\b/gi

function truckingRelevanceScore(row) {
  let score = 0
  const name = row.companyName || ''
  const blob = [name, row.projectSummary, row.industry, row.scopeOfServices, row.projectName].join(' ')

  if (/\btruck|trailer\b/i.test(name)) score += 14
  if (TRUCKING_SIGNALS.test(name)) score += 10
  if (rowIndustryBucket(row) === 'logistics') score += 6
  if (TRUCKING_SIGNALS.test(blob)) score += 3
  if (WEB_SCOPE_SIGNALS.test(blob)) score += 4
  return score
}

export function findTruckingWebsiteProjects(knowledge = [], { limit = 2, excludeNames = [] } = {}) {
  const exclude = new Set(excludeNames.map(n => n.trim().toLowerCase()).filter(Boolean))

  return knowledge
    .filter(row => {
      if (!row.companyName?.trim()) return false
      if (exclude.has(row.companyName.trim().toLowerCase())) return false
      const blob = [row.companyName, row.scopeOfServices, row.projectSummary, row.projectName, row.industry].join(' ')
      // Must be an actual logistics/trucking project — a generic web score alone
      // was letting healthcare (and other) projects through on trucking turns.
      const isLogistics = rowIndustryBucket(row) === 'logistics' || TRUCKING_SIGNALS.test(blob)
      return isLogistics && WEB_SCOPE_SIGNALS.test(blob)
    })
    .map(row => ({ row, score: truckingRelevanceScore(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.row)
}

export function speakableScope(row) {
  const summary = row.projectSummary?.trim()
  if (summary && !isRawNotesText(summary)) {
    let first = summary.split(/[.!?]/)[0].trim()
    first = first.replace(/^(?:we |they )?(?:built|developed|redesigned|created|implemented)\s+/i, '')
    if (first.length > 12 && first.length <= 90 && !isRawNotesText(first)) return first
  }

  const cleanedName = cleanProjectNameLabel(row.projectName, row.scopeOfServices)
  if (cleanedName) return cleanedName

  const scope = (row.scopeOfServices || '').toLowerCase()
  if (/web design/.test(scope) && !/application|software/.test(scope)) return 'a marketing website'
  if (/web application|portal/.test(scope)) return 'a customer web portal'
  if (/app development|mobile/.test(scope)) return 'a mobile app'
  if (/software development/.test(scope)) return 'custom ops software'
  return 'a custom website'
}

function shortScope(row) {
  return speakableScope(row)
}

export function buildPortfolioCiteLine(projects = []) {
  const picks = projects.filter(p => p?.companyName).slice(0, 2)
  if (picks.length >= 2) {
    return `Yes — we built ${shortScope(picks[0])} for ${picks[0].companyName} and ${shortScope(picks[1])} for ${picks[1].companyName}.`
  }
  if (picks.length === 1) {
    return `Yes — we built ${shortScope(picks[0])} for ${picks[0].companyName}.`
  }
  return ''
}

export function buildPortfolioNamesLine(projects = []) {
  const picks = projects.filter(p => p?.companyName).slice(0, 3)
  if (picks.length >= 2) {
    const names = picks.map(p => p.companyName)
    const scopes = picks.map(p => shortScope(p))
    return `Yes — ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}: we built ${scopes.slice(0, -1).join(', ')} and ${scopes[scopes.length - 1]}.`
  }
  if (picks.length === 1) {
    return `Yes — ${picks[0].companyName}: we built ${shortScope(picks[0])}.`
  }
  return ''
}

export function buildPortfolioDetailsLine(projects = []) {
  const picks = dedupeProjectsByCompany(projects.filter(p => p?.companyName), 2)
  if (!picks.length) return ''

  return picks
    .map(p => `For ${p.companyName}: ${speakableScope(p)}.`)
    .join(' ')
}

export function extractCitedClientNames(text = '', allowedNames = []) {
  const lower = text.toLowerCase()
  return allowedNames.filter(name => {
    const n = name.trim().toLowerCase()
    return n.length > 2 && lower.includes(n)
  })
}

function filterProjectsByProspectIndustry(projects = [], contextText = '', brief = {}) {
  const industries = detectProspectIndustries(`${contextText} ${brief?.priorConversations || ''}`)
  if (!industries.length || !projects.length) return projects

  if (industries.includes('finance')) {
    const lending = projects.filter(isLendingPortfolioRow)
    if (lending.length) return lending
  }

  const filtered = projects.filter(row => rowIndustryBucket(row) === industries[0])
  return filtered
}

export function pickPortfolioProjects(knowledge = [], options = {}) {
  const {
    limit = 2,
    excludeNames = [],
    truckingOnly = false,
    citedNames = [],
    contextText = '',
    brief = {},
    preferRelevant = false,
  } = options

  const contextBlob = `${contextText} ${brief?.priorConversations || ''}`
  const industries = detectProspectIndustries(contextBlob)
  const financeContext = industries.includes('finance')
    || /\b(lending|loan|mortgage|borrower|appraisal|underwriting|dscr|fix-and-flip|construction lending|bridge lending|draw request|los\b)\b/i.test(contextBlob)

  if (citedNames.length) {
    const citedRows = citedNames
      .map(name => knowledge.find(row => row.companyName?.trim().toLowerCase() === name.trim().toLowerCase()))
      .filter(Boolean)
    if (citedRows.length) return dedupeProjectsByCompany(citedRows, limit)
  }

  if (financeContext) {
    const lending = findFinanceLendingProjects(knowledge, { limit, excludeNames })
    if (lending.length) return lending
  }

  if (preferRelevant || !truckingOnly) {
    const relevant = findRelevantProjects(knowledge, contextText, brief, limit * 3)
    const filtered = filterProjectsByProspectIndustry(relevant, contextText, brief)
    if (filtered.length) return dedupeProjectsByCompany(filtered, limit)
  }

  if (truckingOnly) {
    const trucking = findTruckingWebsiteProjects(knowledge, { limit, excludeNames })
    if (trucking.length) return trucking
  }

  if (industries.length) {
    const industryRows = findIndustryProjects(knowledge, industries[0], limit * 2)
    const filtered = industries[0] === 'finance'
      ? industryRows.filter(isLendingPortfolioRow)
      : industryRows
    if (filtered.length) return dedupeProjectsByCompany(filtered, limit)
  }

  return []
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

  const prospectIndustries = detectProspectIndustries(`${contextText} ${brief?.priorConversations || ''}`)
  const rowBucket = rowIndustryBucket(row)

  if (prospectIndustries.length && rowBucket) {
    if (prospectIndustries.includes(rowBucket)) score += 12
    else score -= 20
  } else if (prospectIndustries.length && !rowBucket) {
    score -= 6
  }

  if (prospectIndustries.includes('finance') && isLendingPortfolioRow(row)) {
    score += 10
  }
  if (prospectIndustries.includes('finance') && AGRICULTURE_SIGNALS.test(fields) && !isLendingPortfolioRow(row)) {
    score -= 25
  }

  for (const keyword of INDUSTRY_KEYWORDS) {
    if (fields.includes(keyword) && contextTokens.some(t => t.includes(keyword) || keyword.includes(t))) {
      score += 3
    }
  }

  if (brief.clientCompany && fields.includes(brief.clientCompany.toLowerCase())) {
    score += 5
  }

  if (brief.priorConversations) {
    for (const token of tokenize(brief.priorConversations)) {
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

  const picks = dedupeProjectsByCompany(scored.map(item => item.row), limit)
  if (picks.length > 0) return picks

  const industries = detectProspectIndustries(`${contextText} ${brief?.priorConversations || ''}`)
  if (industries.includes('finance')) {
    const lending = findFinanceLendingProjects(knowledge, { limit })
    if (lending.length) return lending
  }
  if (industries.length) {
    const industryRows = findIndustryProjects(knowledge, industries[0], limit)
    if (industryRows.length) return dedupeProjectsByCompany(industryRows, limit)
  }

  return []
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

  return `RELEVANT PAST WORK (portfolio only — companies WE built for, NOT the prospect's vendors):
${lines.join('\n\n')}

ALLOWED PAST CLIENT NAMES (cite only as past work: "we built … for [name]"):
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
- When client asks for price, estimate, budget, or ballpark: state dollar amounts from ESTIMATED PRICE GUIDANCE above. You must say the prices out loud.
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
Past client names (portfolio — we built for them): ${names.join(', ') || 'none loaded'}.
Prospect on this call (NOT a past client): ${clientCompany || 'unknown'}.
Never confuse portfolio names with the prospect's systems or stated needs.`
}
