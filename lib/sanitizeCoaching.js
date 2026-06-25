import { stripFluffFromText, tightenToDirectSpeech } from './stripFluff'
import {
  applyTrustTurnSanitize,
  buildPriorCoachingDigest,
  extractSectionBodies,
  followUpAlreadyAsked,
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
} from './antiRepeat'
import { stripInventedProspectAttribution } from './prospectAttribution'
import { buildPortfolioCiteLine, buildPortfolioDetailsLine, buildPortfolioNamesLine, extractCitedClientNames, pickPortfolioProjects } from './knowledgeHelpers'

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
}

function forcePortfolioSay(intent = {}, portfolioProjects = []) {
  if (!portfolioProjects?.length) return ''

  if (intent.askingPortfolioDetails) return buildPortfolioDetailsLine(portfolioProjects)
  if (intent.askingPortfolioNames) return buildPortfolioNamesLine(portfolioProjects)
  if (intent.askingIndustryExperience || (intent.askingCredibility && intent.logisticsContext)) {
    return buildPortfolioCiteLine(portfolioProjects)
  }
  return ''
}

function portfolioFollowUp(intent = {}, priorFollow = [], clientCompany = '') {
  if (intent.askingPortfolioDetails) {
    return 'Which of those features matters most for your rebuild?'
  }
  if (intent.askingPortfolioNames) {
    return 'Want a quick walkthrough of what we built for either one?'
  }
  if (priorFollow.some(f => /\bwhat kind of trucking\b/i.test(f))) {
    const company = clientCompany || 'your team'
    return `Which of those builds is closest to what ${company} needs?`
  }
  return 'What kind of trucking or logistics site are you trying to launch first?'
}

function buildSayFallback(options = {}) {
  const {
    clientCompany = '',
    fallbackNames = [],
    portfolioProjects = [],
    intent = {},
    websiteSnippet = '',
    priorConversations = '',
  } = options

  const portfolioLine = forcePortfolioSay(intent, portfolioProjects)
  if (portfolioLine) return portfolioLine

  if (intent.askingIndustryExperience || (intent.askingCredibility && intent.logisticsContext)) {
    const names = fallbackNames.filter(Boolean).slice(0, 2)
    if (names.length >= 2) {
      return `Yes — we built custom websites and tools for ${names[0]} and ${names[1]}, scoped to their logistics workflows.`
    }
    if (names.length === 1) {
      return `Yes — we built a custom site and ops tools for ${names[0]} in logistics.`
    }
    return 'Yes — we have logistics and trucking builds in our portfolio; I can walk through two comparable projects.'
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
    intent = {},
    websiteSnippet = '',
    priorConversations = '',
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
    sanitizedSay = stripUnknownPastClientCitations(sanitizedSay, options)
    sanitizedSay = stripFabricatedClientNames(sanitizedSay, options)
    sanitizedSay = stripInventedPricing(sanitizedSay, options)
    sanitizedSay = tightenToDirectSpeech(stripFluffFromText(sanitizedSay), {
      maxSentences: (intent.askingWhatYouKnow || intent.askingAboutCompany) ? 2 : 3,
    })

    const { say: sayWithoutQuestions, trailingQuestion } = stripQuestionsFromSay(sanitizedSay)
    sanitizedSay = sayWithoutQuestions || sanitizedSay

    const needsPortfolioLine = intent.askingIndustryExperience
      || intent.askingPortfolioNames
      || intent.askingPortfolioDetails
      || (intent.askingCredibility && intent.logisticsContext)
    const credibilityMissing = needsPortfolioLine
      && (!sayCitesPortfolioName(sanitizedSay, options.fallbackNames) || sayLooksLikeClosingPivot(sanitizedSay))

    const sayTooWeak = !sanitizedSay.trim()
      || sanitizedSay.length < 25
      || /^(Both|These|Those)\s+projects\b/i.test(sanitizedSay)
      || credibilityMissing
      || (needsPortfolioLine && containsRawServiceTypes(sanitizedSay))

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
      })
      if (fallback) sanitizedSay = fallback
    }

    result = `${label}${sanitizedSay}${result.slice(sayMatch.index + sayMatch[0].length)}`

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

  result = dedupeFollowUpSection(result)
  result = stripQuickContextSection(result)

  const needsPortfolioAnswer = intent.askingIndustryExperience
    || intent.askingPortfolioNames
    || intent.askingPortfolioDetails
    || (intent.askingCredibility && intent.logisticsContext)
  if (needsPortfolioAnswer) {
    const followBody = result.match(/\*\*Follow-up:\*\*\s*([\s\S]*)$/i)?.[1]?.trim() || ''
    const desiredFollow = portfolioFollowUp(intent, priorFollow, options.clientCompany)
    if (!followBody || sayLooksLikeClosingPivot(followBody) || followUpAlreadyAsked(followBody, priorFollow)) {
      result = result.replace(/\n\*\*Follow-up:\*\*[\s\S]*$/i, '').trim()
      result = `${result}\n\n**Follow-up:** ${desiredFollow}`
    }
  }

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

  const logisticsContext = /\b(trucking|logistics|freight|transportation|dispatch)\b/i.test(`${latestClient} ${fullClient}`)
  const askingIndustryExperience = (
    /\b(trucking|logistics|freight|transportation)\b/i.test(latestClient)
    || logisticsContext
  ) && /\b(experience|built|building|websites?|worked|done|portfolio)\b/i.test(latestClient)
  const askingAboutCompany = /\btell me (?:something )?about (?:my|our) company\b|\bsomething about (?:my|our) company\b|\bwhat (?:my|our) company does\b|\babout (?:my|our) company\b/i.test(latestClient)
  const askingWhatYouKnow = /\bwhat you know (?:about|so far)|tell me (?:about )?what you know|what do you know\b|\bwhat you think (?:my|our) company needs\b/i.test(latestClient)
    || askingAboutCompany
    || /\btell me\b.{0,80}\b(?:echo|company|what we do)\b/i.test(latestClient)
  const askingPortfolioNames = /\b(names? of|give me names?|which (?:trucking|logistics)|what (?:trucking|logistics) companies|who did you (?:work|build)|recently built websites? with)\b/i.test(latestClient)
    && (logisticsContext || /\btrucking\b/i.test(latestClient))
  const askingPortfolioDetails = /\b(what kind of (?:websites?|sites?)|features? (?:did you|you built)|built for (?:these|those)|tell me (?:more )?about (?:the )?(?:sites?|websites?|work|builds))\b/i.test(latestClient)
    || (/\bfeatures?\b/i.test(latestClient) && /\b(these|those|companies)\b/i.test(latestClient))

  return {
    askingPrice: pricePattern.test(latestClient),
    priceAskCount,
    clientStatedBudget: Boolean(clientBudgetMatch),
    clientBudgetText: clientBudgetMatch?.[0] || '',
    askingFullSystem: /\b(all details|whole system|full system|entire system|what (will|would) (you |we )?build|complete (solution|system|platform)|walk me through|overview of|everything (you|we)('ll| will))\b/.test(latestClient),
    readyToClose: /\b(send it|copy\s+\w+|ready to move|if the numbers work|sounds good|let'?s (proceed|move forward)|we'?re ready)\b/i.test(latestClient),
    askingCredibility: /\b(have you (actually )?done|do you have (?:any )?experience|experience (?:in|with|building)|worked in (our|this) space|similar work|built (?:for|websites? for)|for which ones)\b/i.test(latestClient),
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
    clientRejectedTmsReplacement: /\b(that'?s never happening|never happening|won'?t replace|not replacing).{0,40}\b(tms|transportation management)\b|\b(tms|transportation management).{0,40}(never|not replacing|won'?t replace)/i.test(fullClient),
    askingWhatYouKnow,
    askingAboutCompany,
    askingIndustryExperience,
    logisticsContext,
    askingPortfolioNames,
    askingPortfolioDetails,
    alreadyPromisedProposal,
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
  )

  if (intent.askingPortfolioDetails) {
    lines.push(`**PRIORITY — client asked what we built and the features.** For each company already named in this meeting, state website type and 2-3 features from RELEVANT PAST WORK project summaries. No timeline or budget questions.`)
  } else if (intent.askingPortfolioNames) {
    lines.push(`**PRIORITY — client wants trucking company names.** List 2-3 trucking/logistics client names from ALLOWED PAST CLIENT NAMES only. No service-type labels like "Web Design, Web Application". Names only plus one short clause.`)
  } else if (intent.askingIndustryExperience) {
    lines.push(`**PRIORITY — client asked about trucking/logistics experience.** Say this next MUST answer yes and name exactly 2 past clients from ALLOWED PAST CLIENT NAMES with scope from RELEVANT PAST WORK. Do NOT ask about timeline, budget, SOW, or decision-maker this turn.`)
  } else if (intent.askingCredibility) {
    lines.push(`**PRIORITY — client asked about industry experience.** Say this next MUST name 2 past clients from ALLOWED PAST CLIENT NAMES with scope. Do NOT pivot to timeline, budget, or closing questions.`)
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
    lines.push(`**Client doubts portfolio fit.** Name 2-3 DIFFERENT past clients from ALLOWED PAST CLIENT NAMES that match their industry AND problem (e.g. healthcare web apps for a patient portal). Explain why scope is comparable even if product name differs. Do NOT repeat the same past client cited in prior coaching. Never cite trucking/logistics projects for a healthcare client.`)
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
