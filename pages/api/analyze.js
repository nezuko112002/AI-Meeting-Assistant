import OpenAI from 'openai'
import {
  buildIntentGuidance,
  detectClientIntent,
  sanitizeCoachingResponse,
} from '../../lib/sanitizeCoaching'
import { buildSystemPrompt, getKnowledgeContextForSanitize } from '../../lib/buildAnalyzePrompt'
import { findRelevantProjects, getKnowledgeCompanyNames, getAllowedSheetPrices } from '../../lib/knowledgeHelpers'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function getSpeakerLabel(speaker, speakerMap) {
  if (speakerMap?.[speaker]) return speakerMap[speaker]
  if (speaker === 'Boss' || speaker === 'Client') return speaker
  return `Speaker ${speaker}`
}

function isClientUtterance(utterance, speakerMap) {
  const label = getSpeakerLabel(utterance?.speaker, speakerMap).trim().toLowerCase()
  if (utterance?.speaker === 'Boss' || label === 'boss') return false
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

function buildRecentCoaching(history = []) {
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

  if (/\bphase one is \$[\d,]+/i.test(priorSay)) {
    digest.push('- Phase-one price already stated — do not repeat unless client asked price again.')
  }
  if (/\b(mid-august|weekly demos?)\b/i.test(priorSay)) {
    digest.push('- Deadline/demo pitch already stated — do not repeat on trust or process turns.')
  }
  if (/\bwhat specific features\b/i.test(priorSay)) {
    digest.push('- Portal feature question already asked — ask something new.')
  }

  const digestBlock = digest.length ? `\nAlready covered (do NOT repeat):\n${digest.join('\n')}` : ''

  return `\n\nPrior coaching this meeting (advance the thread — new facts only, no recycled sentences):${digestBlock}\n${recentSuggestions}`
}

function extractClientStatedPrices(fullTranscriptText = '') {
  return [...(fullTranscriptText.match(/\$[\d,]+(?:\s*(?:to|-|–)\s*\$[\d,]+)?/gi) || [])]
}

function collectSanitizeOptions(knowledge, brief, contextText, fullTranscriptText, clientIntent = {}, history = []) {
  const relevant = findRelevantProjects(knowledge, contextText, brief)
  const allowedNames = getKnowledgeContextForSanitize(knowledge)
  const sheetPrices = getAllowedSheetPrices(knowledge, relevant, `${contextText}\n${fullTranscriptText}`)
  const clientStatedPrices = extractClientStatedPrices(fullTranscriptText)

  return {
    allowPricing: Boolean(clientIntent.askingPrice || clientIntent.clientStatedBudget),
    allowPriceRepeat: Boolean(clientIntent.askingPrice),
    allowDeadlineRepeat: Boolean(clientIntent.askingDeadline && !clientIntent.alreadyStatedDeadlinePitch),
    askingTrust: Boolean(clientIntent.askingTrust),
    alreadyStatedDeadlinePitch: Boolean(clientIntent.alreadyStatedDeadlinePitch),
    alreadyStatedAccountLead: Boolean(clientIntent.alreadyStatedAccountLead),
    allowedNames,
    fallbackNames: getKnowledgeCompanyNames(relevant),
    clientCompany: brief?.clientCompany || '',
    documentedPrices: sheetPrices,
    clientStatedPrices,
    history,
    meetingContext: contextText,
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
  const contextText = `${fullTranscriptText}\n${brief?.background || ''}\n${brief?.meetingGoal || ''}`

  const clientIntent = detectClientIntent(latestUtterances, speakerMap, {
    fullMeetingUtterances: mergedFullMeetingUtterances,
    history,
  })
  const intentGuidance = buildIntentGuidance(clientIntent)

  const systemPrompt = buildSystemPrompt({ company, brief, knowledge, contextText })
  const sanitizeOptions = collectSanitizeOptions(knowledge, brief, contextText, fullTranscriptText, clientIntent, history)

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Full meeting transcript:\n${fullTranscriptText}

Latest exchange since last coaching (Boss + Client):\n${latestExchangeText}${buildRecentCoaching(history)}${intentGuidance}

Coach Boss on what to say next. Answer ONLY what is NEW in the client's latest message. If price was already stated in prior coaching, do not repeat it unless they asked price again. If client asked for price for the first time, state spreadsheet-backed dollar amounts. One unified proposal — extend what was already discussed. Direct opener only. Two sections only: Say this next and Follow-up.`,
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
