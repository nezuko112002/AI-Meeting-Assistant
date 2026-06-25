import OpenAI from 'openai'
import {
  buildIntentGuidance,
  detectClientIntent,
  sanitizeCoachingResponse,
} from '../../lib/sanitizeCoaching'
import { buildSystemPrompt, getKnowledgeContextForSanitize } from '../../lib/buildAnalyzePrompt'
import {
  extractCitedClientNames,
  findRelevantProjects,
  getKnowledgeCompanyNames,
  getAllowedSheetPrices,
  pickPortfolioProjects,
} from '../../lib/knowledgeHelpers'
import { fetchWebsiteSnippet } from '../../lib/fetchWebsiteSnippet'
import { buildProspectFactContext } from '../../lib/prospectAttribution'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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
  ].filter(Boolean).join('\n')

  const clientIntent = detectClientIntent(latestUtterances, speakerMap, {
    fullMeetingUtterances: mergedFullMeetingUtterances,
    history,
  })
  const intentGuidance = buildIntentGuidance(clientIntent)

  const systemPrompt = buildSystemPrompt({ company, brief: enrichedBrief, knowledge, contextText })
  const sanitizeOptions = collectSanitizeOptions(knowledge, enrichedBrief, contextText, fullTranscriptText, clientIntent, history)

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Full meeting transcript:\n${fullTranscriptText}

Latest exchange since last coaching (You + Client):\n${latestExchangeText}${buildRecentCoaching(history, clientIntent)}${intentGuidance}

Coach the salesperson (You) on what to say next. Cite spreadsheet clients as past work we delivered when asked about experience. Never describe portfolio names as the prospect's systems unless they said so in the transcript or brief. Never refuse with "I can't provide details". Answer ONLY what is NEW in the client's latest message. Two sections only: Say this next and Follow-up.`,
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
