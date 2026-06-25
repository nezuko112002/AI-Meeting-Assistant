import { stripFluffFromText, tightenToDirectSpeech } from './stripFluff'
import {
  applyTrustTurnSanitize,
  buildPriorCoachingDigest,
  extractSectionBodies,
  followUpAlreadyAsked,
  stripMismatchedScope,
  stripIndustryMismatchComparable,
  stripRepeatedComparableClient,
  stripRepeatedDeadlinePitch,
  stripRepeatedPriceMention,
  stripRepeatedSentences,
  stripSimilarToOurClauses,
} from './antiRepeat'

function stripQuickContextSection(text = '') {
  return text.replace(/\n?\*\*Quick context:\*\*[\s\S]*?(?=\n\*\*Follow-up:\*\*|$)/i, '\n').trim()
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
  return tightenToDirectSpeech(stripFluffFromText(sayText), { maxSentences: 3 })
}

export function stripInventedPricing(text, { allowPricing = false, documentedPrices = [], clientStatedPrices = [] } = {}) {
  if (allowPricing || !text) return text

  const allowedPriceStrings = [
    ...documentedPrices,
    ...clientStatedPrices,
  ].map(p => p.toLowerCase())

  return text.replace(INVENTED_PRICE_PATTERN, (match) => {
    const lower = match.toLowerCase()
    const normalizedMatch = lower.replace(/[^\d$,.k-–]/g, '')
    if (allowedPriceStrings.some(p => {
      const norm = p.replace(/[^\d$,.k-–]/g, '')
      return norm && (norm.includes(normalizedMatch) || normalizedMatch.includes(norm))
    })) {
      return match
    }
    return 'your stated budget range'
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

export function dedupeFollowUpSection(text) {
  const sayMatch = text.match(/\*\*Say this next:\*\*\s*([\s\S]*?)(?=\n\*\*Follow-up:\*\*|$)/i)
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
  } = options

  const { priorSay, priorFollow } = buildPriorCoachingDigest(history)

  let result = stripQuickContextSection(text)

  const sayMatch = result.match(/(\*\*Say this next:\*\*\s*)([\s\S]*?)(?=\n\*\*Follow-up:\*\*|$)/i)
  if (sayMatch) {
    const [, label, sayBody] = sayMatch
    let sanitizedSay = sanitizeSayThisNext(sayBody)
    sanitizedSay = stripMismatchedScope(sanitizedSay, meetingContext)
    sanitizedSay = stripSimilarToOurClauses(sanitizedSay, meetingContext, priorSay)
    sanitizedSay = stripIndustryMismatchComparable(sanitizedSay, meetingContext)
    sanitizedSay = stripRepeatedSentences(sanitizedSay, priorSay)
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
    sanitizedSay = stripUnknownPastClientCitations(sanitizedSay, options)
    sanitizedSay = stripFabricatedClientNames(sanitizedSay, options)
    sanitizedSay = stripInventedPricing(sanitizedSay, options)
    sanitizedSay = tightenToDirectSpeech(stripFluffFromText(sanitizedSay), { maxSentences: 3 })
    result = `${label}${sanitizedSay}${result.slice(sayMatch.index + sayMatch[0].length)}`
  } else {
    result = stripFluffFromText(stripFabricatedClientNames(stripInventedPricing(result, options), options))
  }

  const followMatch = result.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)
  if (followMatch?.[1]?.trim()) {
    let sanitizedFollow = stripFluffFromText(followMatch[1])
    if (followUpAlreadyAsked(sanitizedFollow, priorFollow)) {
      result = result.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '')
    } else if (sanitizedFollow) {
      result = result.replace(/\*\*Follow-up:\*\*[\s\S]*$/i, `**Follow-up:** ${sanitizedFollow}`)
    }
  }

  result = dedupeFollowUpSection(result)
  result = stripQuickContextSection(result)

  return result.trim()
}

function getClientText(utterances = [], speakerMap = {}) {
  return utterances
    .filter(u => {
      const label = (speakerMap?.[u.speaker] || u.speaker || '').toString().trim().toLowerCase()
      if (u.speaker === 'Boss' || label === 'boss') return false
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
    }
  }

  const pricePattern = /\b(price|pricing|cost|budget|quote|estimate|ballpark|numbers?|how much|expense|fee|fees|estimated amount|give me an? (?:estimated )?amount|\$)\b/gi
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

  const clientBudgetMatch = latestClient.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/i)
    || fullClient.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/i)

  return {
    askingPrice: pricePattern.test(latestClient),
    priceAskCount,
    clientStatedBudget: Boolean(clientBudgetMatch),
    clientBudgetText: clientBudgetMatch?.[0] || '',
    askingFullSystem: /\b(all details|whole system|full system|entire system|what (will|would) (you |we )?build|complete (solution|system|platform)|walk me through|overview of|everything (you|we)('ll| will))\b/.test(latestClient),
    readyToClose: /\b(send it|copy\s+\w+|ready to move|if the numbers work|sounds good|let'?s (proceed|move forward)|we'?re ready)\b/i.test(latestClient),
    askingCredibility: /\b(have you (actually )?done|first time in|experience in|worked in (our|this) space|similar work)\b/i.test(latestClient),
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
    portfolioObjection: /\b(didn't see|don't see|did not see|not see anything similar|nothing similar|portfolio)\b/i.test(latestClient),
    askingProcess: /\b(development process|start to finish|from the start|what does .+ look like)\b/i.test(latestClient),
    askingTrust: /\b(bad experience|missed deadlines|how can we trust|trust this)\b/i.test(latestClient),
    askingFreeWork: /\b(free prototype|before we commit|in-house developer|outsourcing)\b/i.test(latestClient),
    alreadyPromisedProposal,
  }
}

export function buildIntentGuidance(intent = {}) {
  const lines = []

  if (intent.alreadyStatedPhaseOnePrice && !intent.askingPrice) {
    lines.push(`**Price already given.** Do NOT restate phase-one dollar amount or repeat the same spreadsheet comparable. Answer ONLY the client's new concern in this turn.`)
  }

  if (intent.portalFeatureAsked) {
    lines.push(`**Portal features already asked.** Do NOT ask "what features are critical" again. Ask kickoff date, who signs the SOW, or budget alignment instead.`)
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
    lines.push(`**CLOSE MODE — client agreed to move forward.** Do NOT ask more scoping or feature questions. Coach Boss to: (1) confirm proposal delivery date, (2) confirm email recipients, (3) list what the document includes (scope, timeline, pricing structure), (4) propose a short review call to sign. Keep it short.`)
  }

  if (intent.askingCompetitor) {
    lines.push(`**Client compared us to a big-bang competitor.** Contrast phased go-live vs monolith. Name phase-one modules already discussed. Tie to their deadline (e.g. peak season).`)
  }

  if (intent.portfolioObjection) {
    lines.push(`**Client doubts portfolio fit.** Name 2-3 DIFFERENT past clients from ALLOWED PAST CLIENT NAMES that match their industry AND problem (e.g. healthcare web apps for a patient portal). Explain why scope is comparable even if product name differs. Do NOT repeat the same past client cited in prior coaching. Never cite trucking/logistics projects for a healthcare client.`)
  }

  if (intent.askingTrust) {
    lines.push(`**Client has vendor trust concerns.** Do NOT repeat the deadline or weekly-demo pitch if already stated. Coach Boss on: (1) locked scope in SOW — no surprise add-ons, (2) named milestones with dates in the contract, (3) what happens if a milestone slips (credit, finish at no extra cost, or escalation to Boss). One healthcare comparable from the sheet only if industry matches.`)
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

  if (intent.askingCredibility) {
    lines.push(`**Client asked about industry experience.** Name 2 different past clients ONLY from ALLOWED PAST CLIENT NAMES in the SAME industry as the prospect. Never invent names. Never cite trucking/logistics for healthcare. Do not reuse a client name already in prior coaching.`)
  }

  if (intent.askingOwnership) {
    lines.push(`**Client asked who owns the relationship.** Coach Boss to name themselves as account lead and mention delivery/PM support in week one.`)
  }

  if (intent.askingOnboarding) {
    lines.push(`**Client asked about first two weeks.** Give concrete week-one (kickoff, workflow mapping, access) and week-two (milestone plan, written scope for finance) agenda.`)
  }

  if (intent.askingFullSystem) {
    lines.push(`**Client wants the full system picture.** Tight 4-6 module spoken summary of ONE unified platform already discussed. Do not pitch a new tool.`)
  }

  if (intent.askingPrice) {
    lines.push(`**Client asked for price / estimate / budget.** Boss MUST state dollar amounts out loud using ESTIMATED PRICE GUIDANCE from the spreadsheet. Use RECOMMENDED PHASE-ONE ESTIMATE if provided. Name the comparable past project from the sheet that supports the number. Break down what is included in phase one at that price.`)
    if (intent.priceAskCount >= 2 || intent.alreadyPromisedProposal) {
      lines.push(`**Client pressed on pricing again.** Do NOT repeat "proposal in 24-48 hours". Give the spreadsheet-backed dollar range again and explain what finance gets on paper.`)
    }
  }

  if (lines.length) {
    lines.push(`**Anti-repeat:** New past client name only. No repeated deferrals. Follow-up must be a question not already asked.`)
  }

  return lines.length ? `\n\nIntent for this moment:\n${lines.join('\n')}` : ''
}
