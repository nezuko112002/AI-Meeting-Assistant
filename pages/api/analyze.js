import OpenAI from 'openai'
import {
  buildIntentGuidance,
  detectClientIntent,
  sanitizeCoachingResponse,
} from '../../lib/sanitizeCoaching'
import { getKnowledgeContextForSanitize } from '../../lib/buildAnalyzePrompt'
import {
  buildAllowedNamesSection,
  buildPriceEstimateSection,
  buildPricingBasisSection,
  extractCitedClientNames,
  findRelevantProjects,
  getKnowledgeCompanyNames,
  getAllowedSheetPrices,
  pickPortfolioProjects,
} from '../../lib/knowledgeHelpers'
import { buildPortfolioFirewallSection, buildProspectFactContext } from '../../lib/prospectAttribution'
import { fetchWebsiteSnippet } from '../../lib/fetchWebsiteSnippet'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const COMPANY_DISPLAY_NAMES = {
  codeupscale: 'CodeUpscale',
  ridgetheory: 'Ridge Theory',
}

const KNOWLEDGE_ROW_CAP = 40

function getSpeakerLabel(speaker, speakerMap) {
  if (speakerMap?.[speaker]) return speakerMap[speaker]
  if (speaker === 'You' || speaker === 'Boss' || speaker === 'Client') {
    return speaker === 'Boss' ? 'You' : speaker
  }
  return `Speaker ${speaker}`
}

function isClientUtterance(utterance, speakerMap) {
  const label = getSpeakerLabel(utterance?.speaker, speakerMap).trim().toLowerCase()
  if (utterance?.speaker === 'You' || utterance?.speaker === 'Boss' || label === 'boss' || label === 'you') return false
  return utterance?.speaker === 'Client' || label === 'client' || Boolean(utterance?.speaker)
}

function mergeConsecutiveUtterances(utterances = []) {
  const merged = []

  for (const utterance of utterances) {
    const text = utterance?.text?.trim()
    if (!utterance || !text) continue

    const last = merged[merged.length - 1]
    if (last?.speaker === utterance.speaker) {
      last.text = `${last.text} ${text}`.replace(/\s+/g, ' ').trim()
      last.end = utterance.end ?? last.end
    } else {
      merged.push({ ...utterance, text })
    }
  }

  return merged
}

function buildTranscriptText(utterances, speakerMap) {
  return utterances
    .map(u => {
      const label = getSpeakerLabel(u.speaker, speakerMap)
      return `${label}: "${u.text}"`
    })
    .join('\n')
}

function tokenizeForScoring(text = '') {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 3)
}

function looksTruncatedSummary(text = '') {
  const trimmed = text.trim()
  return /\.\.\.\s*$|…\s*$|\b(and|with|that|for|to|in|on|by)\s*$/i.test(trimmed)
}

function cleanProjectSummary(text = '') {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ')
  if (!trimmed) {
    return 'Details on file are limited — describe using work type and industry only when speaking.'
  }
  if (looksTruncatedSummary(trimmed)) {
    return 'Internal notes are incomplete — when speaking, name the client, work type, and industry only. Do not quote raw notes.'
  }

  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean)
  let summary = sentences.slice(0, 2).join(' ')
  if (summary.length > 220) {
    summary = `${summary.slice(0, 217).replace(/\s+\S*$/, '')}...`
  }
  return summary
}

function scoreKnowledgeRow(row, brief = {}, contextText = '') {
  let score = 0
  const blob = [
    row.companyName,
    row.scopeOfServices,
    row.industry,
    row.techStack,
    row.projectSummary,
    row.projectName,
  ].join(' ').toLowerCase()

  const tokens = tokenizeForScoring([
    contextText,
    brief?.clientCompany,
    brief?.priorConversations,
    brief?.meetingGoal,
    brief?.websiteSnippet,
  ].filter(Boolean).join(' '))

  for (const token of tokens) {
    if (blob.includes(token)) score += 2
  }

  if (brief?.clientCompany && blob.includes(brief.clientCompany.toLowerCase())) {
    score += 8
  }

  return score
}

function selectKnowledgeRows(knowledge = [], brief = {}, contextText = '') {
  if (!knowledge.length) return []
  if (knowledge.length <= KNOWLEDGE_ROW_CAP) return knowledge

  return knowledge
    .map(row => ({ row, score: scoreKnowledgeRow(row, brief, contextText) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, KNOWLEDGE_ROW_CAP)
    .map(item => item.row)
}

function buildCompanyIdentitySection(company) {
  const displayName = COMPANY_DISPLAY_NAMES[company] || 'the company'
  return `You are the AI meeting copilot for ${displayName}.`
}

function buildBriefSection(brief) {
  if (!brief) return ''

  const lines = []
  if (brief.clientCompany) lines.push(`Prospect company (on this call): ${brief.clientCompany}`)
  if (brief.clientWebsite) lines.push(`Client website: ${brief.clientWebsite}`)
  if (brief.websiteSnippet) lines.push(`Website summary (scraped): ${brief.websiteSnippet}`)
  if (brief.priorConversations) {
    lines.push(`Prior conversations & prep notes (treat as facts the rep already knows):\n${brief.priorConversations}`)
  }
  if (brief.meetingGoal) lines.push(`Meeting goal: ${brief.meetingGoal}`)

  if (!lines.length) return ''

  return `MEETING BRIEF:
${lines.join('\n')}`
}

function buildKnowledgeBaseSection(knowledge = [], brief = {}, contextText = '') {
  const rows = selectKnowledgeRows(knowledge, brief, contextText)
  if (!rows.length) return ''

  const preamble = `The following past work is provided as reference only.
Read all entries but only surface the most relevant ones based on what the prospect is asking about.
Rewrite all descriptions naturally — never copy raw text.`

  const entries = rows.map((row, index) => {
    const summary = cleanProjectSummary(row.projectSummary)
    return `[${index + 1}] Client: ${row.companyName || 'Unknown'}
       Work type: ${row.scopeOfServices || 'Not specified'}
       Industry: ${row.industry || 'Not specified'}
       Tech: ${row.techStack || 'Not specified'}
       What we did: ${summary}`
  }).join('\n\n')

  return `KNOWLEDGE BASE (past work — reference only):
${preamble}

${entries}`
}

function buildHowToUseCompanyKnowledgeSection(brief = {}) {
  const meetingType = (brief?.meetingType || '').toLowerCase()
  const toneHint = meetingType.includes('discovery')
    ? 'This is a DISCOVERY call — use the Discovery tone in rule 8.'
    : meetingType.includes('sales')
      ? 'This is a SALES meeting — use the Sales tone in rule 8.'
      : 'No meeting type set — default to confident sales tone unless the transcript is clearly exploratory.'

  return `HOW TO USE COMPANY KNOWLEDGE:

1. RELEVANCE FILTER
   Only reference past clients and projects that are directly relevant to the prospect's industry, problem, or needs.
   If a client is from a completely different industry, do not mention them — it hurts credibility more than it helps.

   Examples:
   - Prospect is in healthcare → reference healthcare clients only
   - Prospect needs trucking website → reference trucking/logistics clients only
   - Prospect wants mobile app → reference mobile app projects only

   Never mention a client just because they appear in the database.
   Ask yourself: would this reference make sense to this specific prospect?

2. NATURAL LANGUAGE — NEVER READ THE DATABASE VERBATIM
   Project descriptions from the knowledge base are raw internal notes.
   Never copy them word-for-word into your response.
   Always rewrite them in natural, confident, conversational language
   as if your boss is speaking from memory — not reading a spreadsheet.

   BAD (raw database text):
   'Build a web application on Microsoft Stack, hosted by Azure
   and build an mobile app that works in....'

   GOOD (natural rewrite):
   'We built them a full web application on Microsoft Azure
   with a companion mobile app — handled the entire build end to end.'

3. NEVER LET DESCRIPTIONS GET CUT OFF
   If a project description in the knowledge base is incomplete
   or seems truncated, do NOT reproduce the incomplete text.
   Instead, paraphrase confidently based on what you know:
   - Mention the client name
   - Mention the type of work (web app, mobile app, web design, etc.)
   - Mention the industry if clear
   - Skip specific details if they're unclear or missing

   It is better to say less confidently than to trail off mid-sentence.

4. PICK THE BEST 2-3 EXAMPLES MAXIMUM
   When asked about past work or experience, never list everything
   in the knowledge base. Pick the 2-3 most impressive and relevant
   examples only.

   Selection criteria (in order of priority):
   a. Same industry as the prospect
   b. Same type of work requested (web app, mobile, design, etc.)
   c. Most recent or most recognizable client names
   d. Projects with the clearest outcomes or summaries

   If you have more than 3 relevant examples, choose the strongest ones.
   Quality over quantity always.

5. SPEAK AS THE BOSS, NOT AS AN AI READING DATA
   Your boss has done this work. She knows these clients personally.
   Write suggested responses in her voice — confident, warm, direct.

   BAD:
   'According to our records, we have worked with AFG Truck Force
   on a marketing website project.'

   GOOD:
   'Yes — we built a marketing website for AFG Truck Force.
   Clean, professional, built to convert. Similar scope to
   what you're describing.'

6. FOLLOW-UP QUESTIONS AFTER EVERY SUGGESTED RESPONSE
   Every suggested response must end with one sharp follow-up question
   that moves the conversation forward.
   The follow-up should be relevant to what was just discussed —
   not generic.

   BAD follow-up: 'Is there anything else you would like to know?'
   GOOD follow-up: 'Which of those features matters most for your rebuild?'
   GOOD follow-up: 'What does your current site look like — do you have a URL?'
   GOOD follow-up: 'Is November a hard deadline or is there some flexibility?'

7. HANDLING QUESTIONS ABOUT CLIENTS NOT IN THE KNOWLEDGE BASE
   If the prospect asks about a specific industry or client type
   and there are no relevant matches in the knowledge base:
   Do NOT fabricate or guess.
   Instead suggest your boss pivot:
   'Pivot gracefully: acknowledge you may not have a direct match
   but highlight transferable experience — similar tech stack,
   similar complexity, similar industry challenges.'

   Example pivot:
   'We haven't worked with a company exactly like yours, but we
   built [relevant adjacent project] which had very similar
   requirements around [shared challenge]. The approach would
   be the same.'

8. TONE BY MEETING TYPE
   Sales meeting:
   - Confident, decisive, outcome-focused
   - Reference past wins to build credibility
   - Every response should move toward commitment
   - Handle objections directly, never defensively

   Discovery call:
   - Curious, warm, consultative
   - Ask more than you tell
   - Reference past work only to validate understanding
   - Goal is to uncover pain, not to pitch

${toneHint}`
}

function buildMeetingTypeSection(brief = {}) {
  if (!brief?.meetingType) return ''

  return `MEETING TYPE: ${brief.meetingType}
Apply the matching tone from HOW TO USE COMPANY KNOWLEDGE (rule 8) for this meeting.`
}

function buildResponseFormatSection() {
  return `COACHING RESPONSE FORMAT

You are a silent real-time sales meeting coach for a software and web development agency.

**Who we are:** We build custom software and redesign/develop websites for other companies. We are the vendor; the company on the other side of the call is the client (prospect or buyer). Our job in every meeting is to win their project.

**Who is on the call:** "You" is our salesperson (our side). "Client" is the prospect company. Coach You on what to say to win the deal.

**Goal:** Move toward a signed SOW — learn their stack and pain when needed, handle objections, state price when asked, and close when they're ready.
When client agrees to receive a proposal ("send it", "if the numbers work"), switch to CLOSE MODE — confirm deliverable, timeline, recipients, and next meeting.

**One evolving proposal:** This meeting builds ONE solution — a single platform or project scope that grows turn by turn. Read the full transcript, infer what we've already proposed, and EXTEND that thread. Never restart with an unrelated product.
Do NOT invent pain points. Reference past work ONLY as portfolio proof ("we built X for [past client]") after the client has described their situation — never as the prospect's stated needs.

**Portfolio rule:** Cite spreadsheet clients as past work we delivered. Never describe them as the prospect's systems unless the client or prep notes said so.
**Company knowledge:** When asked what you know about the prospect, use MEETING BRIEF prep notes and website first — max 2 short speakable sentences.
**Industry experience:** When asked if you've worked in their industry, name 2-3 ALLOWED past clients max with natural descriptions — required, not optional.

Provide your coaching using these sections. Omit any section that is not needed for this exchange — do not pad with empty sections.

**💡 What they're asking:**
  [What the client actually wants to know — plain English, 1-2 sentences max]

**🎯 Say this:**
  [Exact suggested response your boss can say out loud — written in her voice, natural, confident. Must end with one sharp follow-up question that moves the conversation forward.]

**📖 Good to know:**
  [Only include if there's genuinely useful context — a relevant fact, industry term, or background info she might not know. Skip this section if not needed.]

A response with just "What they're asking" and "Say this" is perfectly fine.

Banned in **🎯 Say this:** — never write these:
- Empathy filler: "I understand", "Great question", "That makes sense", "Absolutely"
- Database voice: "According to our records", "Our records show"
- Refusals: "I can't provide details about your company"
- Raw spreadsheet scope labels copied verbatim (e.g. "Web Design, Web Application, Software Development for...")
- Truncated or mid-sentence project descriptions`
}

function buildAnalyzeSystemPrompt({ company, brief, knowledge = [], contextText = '' }) {
  const relevantProjects = findRelevantProjects(knowledge, contextText, brief)
  const meetingContext = contextText.toLowerCase()

  const sections = [
    buildCompanyIdentitySection(company),
    buildPortfolioFirewallSection(knowledge, brief),
    buildAllowedNamesSection(knowledge, brief?.clientCompany),
    buildKnowledgeBaseSection(knowledge, brief, contextText),
    buildHowToUseCompanyKnowledgeSection(brief),
    buildMeetingTypeSection(brief),
    knowledge.length ? buildPricingBasisSection(knowledge, relevantProjects, meetingContext) : '',
    knowledge.length ? buildPriceEstimateSection(knowledge, relevantProjects, contextText) : '',
    buildBriefSection(brief),
    buildResponseFormatSection(),
  ].filter(Boolean)

  return sections.join('\n\n')
}

function clientAskedDistinctQuestion(intent = {}) {
  return Boolean(
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
}

function buildRecentCoaching(history = [], clientIntent = {}) {
  const recentSuggestions = history
    .filter(h => h.role === 'assistant' && h.content)
    .slice(-3)
    .map((h, index) => `${index + 1}. ${h.content}`)
    .join('\n\n')

  if (!recentSuggestions) return ''

  const digest = []
  const priorSay = history
    .filter(h => h.role === 'assistant')
    .map(h => h.content || '')
    .join(' ')
  const skipAntiRepeatDigests = clientAskedDistinctQuestion(clientIntent)

  if (!skipAntiRepeatDigests && /\bphase one is \$[\d,]+/i.test(priorSay)) {
    digest.push('- Phase-one price already stated — do not repeat unless client asked price again.')
  }
  if (!skipAntiRepeatDigests && /\b(mid-august|weekly demos?)\b/i.test(priorSay)) {
    digest.push('- Deadline/demo pitch already stated — do not repeat on trust or process turns.')
  }
  if (!skipAntiRepeatDigests && /\bwhat specific features\b/i.test(priorSay)) {
    digest.push('- Feature-priority question already asked — ask something new next turn.')
  }
  digest.push('- Portfolio names are past clients we built for — never the prospect\'s systems.')

  const digestBlock = digest.length ? `\nAlready covered (do NOT repeat):\n${digest.join('\n')}` : ''

  return `\n\nPrior coaching this meeting (advance the thread — new facts only, no recycled sentences):${digestBlock}\n${recentSuggestions}`
}

function extractClientStatedPrices(fullTranscriptText = '') {
  return [...(fullTranscriptText.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/gi) || [])]
}

function collectSanitizeOptions(knowledge, brief, contextText, fullTranscriptText, clientIntent = {}, history = []) {
  const relevant = findRelevantProjects(knowledge, contextText, brief)
  const allowedNames = getKnowledgeContextForSanitize(knowledge)
  const priorCoachingText = history
    .filter(h => h.role === 'assistant')
    .map(h => h.content || '')
    .join('\n')
  const priorCited = extractCitedClientNames(priorCoachingText, allowedNames)
  const truckingTurn = clientIntent.askingIndustryExperience
    || clientIntent.askingPortfolioNames
    || clientIntent.askingPortfolioDetails
    || (clientIntent.askingCredibility && clientIntent.logisticsContext)
  const portfolioProjects = truckingTurn
    ? pickPortfolioProjects(knowledge, {
      limit: clientIntent.askingPortfolioNames ? 3 : 2,
      excludeNames: clientIntent.askingPortfolioNames ? priorCited : [],
      truckingOnly: true,
      citedNames: clientIntent.askingPortfolioDetails ? priorCited : [],
    })
    : relevant
  const sheetPrices = getAllowedSheetPrices(knowledge, relevant, `${contextText}\n${fullTranscriptText}`)
  const clientStatedPrices = extractClientStatedPrices(fullTranscriptText)
  const factContext = buildProspectFactContext(fullTranscriptText, brief)

  return {
    allowPricing: Boolean(clientIntent.askingPrice || clientIntent.clientStatedBudget),
    allowPriceRepeat: Boolean(clientIntent.askingPrice),
    allowDeadlineRepeat: Boolean(clientIntent.askingDeadline && !clientIntent.alreadyStatedDeadlinePitch),
    askingTrust: Boolean(clientIntent.askingTrust),
    alreadyStatedDeadlinePitch: Boolean(clientIntent.alreadyStatedDeadlinePitch),
    alreadyStatedAccountLead: Boolean(clientIntent.alreadyStatedAccountLead),
    allowedNames,
    portfolioNames: allowedNames,
    factContext,
    fallbackNames: getKnowledgeCompanyNames(portfolioProjects),
    portfolioProjects,
    clientCompany: brief?.clientCompany || '',
    clientRejectedTmsReplacement: Boolean(clientIntent.clientRejectedTmsReplacement),
    documentedPrices: sheetPrices,
    clientStatedPrices,
    history,
    meetingContext: contextText,
    intent: clientIntent,
    websiteSnippet: brief?.websiteSnippet || '',
    priorConversations: brief?.priorConversations || '',
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    utterances,
    meetingTranscriptFromStart,
    history = [],
    speakerMap,
    knowledge = [],
    brief,
    company,
  } = req.body

  if (!utterances || utterances.length === 0) return res.status(400).json({ error: 'No utterances' })
  if (!utterances.some(u => isClientUtterance(u, speakerMap))) {
    return res.status(204).end()
  }

  const latestUtterances = mergeConsecutiveUtterances(utterances)
  const fullMeetingUtterances = Array.isArray(meetingTranscriptFromStart) && meetingTranscriptFromStart.length > 0
    ? meetingTranscriptFromStart
    : latestUtterances
  const mergedFullMeetingUtterances = mergeConsecutiveUtterances(fullMeetingUtterances)
  const fullTranscriptText = buildTranscriptText(mergedFullMeetingUtterances, speakerMap)
  const latestExchangeText = buildTranscriptText(latestUtterances, speakerMap)

  let enrichedBrief = { ...brief }
  if (brief?.clientWebsite && !brief?.websiteSnippet) {
    const websiteSnippet = await fetchWebsiteSnippet(brief.clientWebsite)
    if (websiteSnippet) enrichedBrief = { ...enrichedBrief, websiteSnippet }
  }

  const contextText = [
    fullTranscriptText,
    enrichedBrief?.priorConversations,
    enrichedBrief?.websiteSnippet,
    enrichedBrief?.clientCompany,
    enrichedBrief?.meetingGoal,
  ].filter(Boolean).join('\n')

  const clientIntent = detectClientIntent(latestUtterances, speakerMap, {
    fullMeetingUtterances: mergedFullMeetingUtterances,
    history,
  })
  const intentGuidance = buildIntentGuidance(clientIntent)

  const systemPrompt = buildAnalyzeSystemPrompt({
    company,
    brief: enrichedBrief,
    knowledge,
    contextText,
  })
  const sanitizeOptions = collectSanitizeOptions(knowledge, enrichedBrief, contextText, fullTranscriptText, clientIntent, history)

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Full meeting transcript:\n${fullTranscriptText}

Latest exchange since last coaching (You + Client):\n${latestExchangeText}${buildRecentCoaching(history, clientIntent)}${intentGuidance}

Coach the salesperson (You) on what to say next. Answer ONLY what is NEW in the client's latest message.
Use the coaching response format from the system prompt. Omit empty sections.
In **🎯 Say this:** write natural, confident speech — never copy raw knowledge-base text. Cite at most 2-3 relevant past clients when asked about experience. Never describe portfolio names as the prospect's systems unless they said so in the transcript or brief.`,
    },
  ]

  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 420,
      temperature: 0.2,
      stream: true,
    })

    let accumulated = ''

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || ''
      if (delta) {
        accumulated += delta
        res.write(`data: ${JSON.stringify({ text: delta })}\n\n`)
      }
    }

    const sanitized = sanitizeCoachingResponse(accumulated, sanitizeOptions)
    if (sanitized !== accumulated) {
      res.write(`data: ${JSON.stringify({ replace: sanitized })}\n\n`)
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (error) {
    console.error('OpenAI error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI request failed', details: error.message })
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`)
      res.end()
    }
  }
}
