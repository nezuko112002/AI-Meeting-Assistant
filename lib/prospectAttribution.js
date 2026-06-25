import { splitSentences } from './antiRepeat'

const INVENTED_NEED_PATTERNS = [
  /\bI understand you(?:'re| are)\b/i,
  /\byou(?:'re| are) looking for\b/i,
  /\byou need (?:a )?(?:new )?/i,
  /\blooking for a new TMS\b/i,
  /\breplace (?:your|their) TMS\b/i,
  /\bnew TMS solution\b/i,
  /\bwhich aligns with our experience\b/i,
  /\bspecializes in [^.]+ which aligns\b/i,
]

const PORTFOLIO_CITE_AS_PROSPECT_SYSTEMS = /\bintegrat(?:e|es|ing) (?:with )?(?:your )?(?:systems for )?/i

function normalize(text = '') {
  return text.toLowerCase().replace(/[^\w\s.]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function buildProspectFactContext(transcriptText = '', brief = {}) {
  const prepNotes = [brief?.priorConversations, brief?.background]
    .map(s => s?.trim())
    .filter(Boolean)
    .join(' ')

  return normalize([
    transcriptText,
    prepNotes,
    brief?.clientCompany,
    brief?.clientWebsite,
    brief?.websiteSnippet,
  ].filter(Boolean).join(' '))
}

export function nameMentionedInFacts(name, factContext) {
  const n = normalize(name)
  if (!n || n.length < 3) return false
  return factContext.includes(n)
}

function portfolioNameInSentence(sentence, portfolioNames = []) {
  const lower = sentence.toLowerCase()
  return portfolioNames.filter(name => {
    const n = name.trim().toLowerCase()
    return n.length > 2 && lower.includes(n)
  })
}

function sentenceInventsProspectNeeds(sentence, portfolioNames, factContext, clientCompany = '') {
  const lower = sentence.toLowerCase()
  const prospect = clientCompany.trim().toLowerCase()

  const citesPortfolio = portfolioNameInSentence(sentence, portfolioNames)
  const citesPortfolioNotInFacts = citesPortfolio.some(name => !nameMentionedInFacts(name, factContext))

  if (citesPortfolioNotInFacts && (
    PORTFOLIO_CITE_AS_PROSPECT_SYSTEMS.test(sentence) ||
    /\bfor (?:CEA|Cervello|Integrity|Heartline)/i.test(sentence) ||
    /\byour (?:existing )?systems\b/i.test(sentence)
  )) {
    return true
  }

  if (citesPortfolioNotInFacts && INVENTED_NEED_PATTERNS.some(p => p.test(sentence))) {
    return true
  }

  if (INVENTED_NEED_PATTERNS.some(p => p.test(sentence))) {
    const mentionsNeedSubject = /\b(tms|transportation management)\b/i.test(sentence)
    if (mentionsNeedSubject && !/\b(tms|transportation management)\b/i.test(factContext)) {
      return true
    }
  }

  if (prospect && lower.includes(prospect) && /\bspecializes in\b/i.test(sentence)) {
    const afterSpecializes = lower.split('specializes in')[1]?.split(/[,.]/)[0] || ''
    if (afterSpecializes && !factContext.includes(afterSpecializes.trim())) {
      return true
    }
  }

  return false
}

export function stripInventedProspectAttribution(text, options = {}) {
  const {
    portfolioNames = [],
    factContext = '',
    clientCompany = '',
  } = options

  if (!text || !portfolioNames.length) return text

  const kept = splitSentences(text).filter(sentence => {
    return !sentenceInventsProspectNeeds(sentence, portfolioNames, factContext, clientCompany)
  })

  const result = kept.join(' ').trim()
  return result || text.trim()
}

export function buildPortfolioFirewallSection(knowledge = [], brief = {}) {
  const names = [...new Set(
    knowledge.map(row => row.companyName?.trim()).filter(Boolean)
  )]

  if (!names.length) return ''

  const prospect = brief?.clientCompany?.trim() || 'the prospect on this call'

  return `PORTFOLIO vs PROSPECT — CRITICAL:
- Spreadsheet rows are PAST CLIENTS we built for. Cite them as proof: "we built [scope] for [name]".
- Portfolio names (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}) must NEVER be described as tools ${prospect} uses, integrates with, or is looking for — unless the CLIENT or PRIOR CONVERSATIONS said that.
- When client asks what you know about ${prospect}: state facts from MEETING BRIEF (prep notes, website) and the live transcript. If prep is thin, say what you know so far and ask one sharp question. NEVER refuse or say "I can't provide details about your company".
- When client asks about industry experience (e.g. trucking, logistics, healthcare): name 2 ALLOWED PAST CLIENT NAMES from the spreadsheet with scope from their row.
- Do NOT invent pain points or TMS replacement needs the client did not state.
- If the client said they will NOT replace their TMS, do NOT pitch TMS replacement.`
}
