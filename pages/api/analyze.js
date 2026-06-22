import OpenAI from 'openai'
import {
  buildIntentGuidance,
  detectClientIntent,
  sanitizeCoachingResponse,
} from '../../lib/sanitizeCoaching'

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

function buildMissionBrief(brief) {
  if (!brief) return ''

  const lines = [
    brief.company && `Client company (prospect — Boss does NOT work here): ${brief.company}`,
    brief.meetingAbout && `Meeting about: ${brief.meetingAbout}`,
    brief.background && `Background: ${brief.background}`,
    brief.approvedPricing && `Approved pricing to mention: ${brief.approvedPricing}`,
  ].filter(Boolean)

  return lines.length ? `\n\nMission brief:\n${lines.join('\n')}` : ''
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
    .slice(-2)
    .map((h, index) => `${index + 1}. ${h.content}`)
    .join('\n\n')

  if (!recentSuggestions) return ''

  return `\n\nPrior coaching this meeting (do NOT repeat these points, tools, openers, or phrases — advance the thread):\n${recentSuggestions}`
}

function buildGoodOpenerExamples() {
  return `
Good "Say this next" openers (use patterns like these):
- "The platform we'd build has five parts: ..."
- "Yes — here's how we'd handle pricing: ..."
- "For visibility across every survey, we'd add a live job board that ..."
- "HubSpot, DroneDeploy, and QuickBooks would connect through ..."

Bad openers (NEVER use):
- "To enhance your reporting capabilities, we recommend..."
- "To address your scaling issues, we recommend..."
- "We can create a unified platform that..."
- "We recommend implementing..."
`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { utterances, meetingTranscriptFromStart, history = [], speakerMap, missionBrief } = req.body
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
  const clientIntent = detectClientIntent(latestUtterances, speakerMap)
  const intentGuidance = buildIntentGuidance(clientIntent)
  const allowPricing = Boolean(missionBrief?.approvedPricing)

  const systemPrompt = `You are a silent real-time sales meeting coach for a software and web development agency.

**Who we are:** We build custom software and redesign/develop websites for other companies. We are the vendor; the company on the other side of the call is the client (prospect or buyer). Our job in every meeting is to win their project.

**Who is on the call:** "Boss" is our salesperson (our side). "Client" is the prospect company. Coach Boss on what to say to win the deal.

**One evolving proposal:** This meeting builds ONE solution — a single platform or project scope that grows turn by turn. Read the full transcript, infer what we've already proposed, and EXTEND that thread. Never restart with a unrelated product (don't jump from Tableau to Asana to a brand-new app). Each answer adds the next layer: pain → module → integration → visibility → pricing path.

Two core objectives — every response must satisfy both:

1. **Expertise:** Name real tools, stacks, and architectures for their use case. Tie every point to what the client said in THIS meeting.

2. **Persuasion:** Move toward a signed SOW. Propose phases, reduce risk, ask one sharp closing question.

${buildGoodOpenerExamples()}

Writing rules — strict:
- **Say this next** opens with the direct answer — a noun phrase, "Yes —", "The platform includes...", or a specific capability. Never start with "To [verb]..." or "We can/recommend/suggest...".
- No validation fillers: "Absolutely", "Great question", "That makes sense".
- No generic recap of the whole meeting unless the client explicitly asks for the full system.
- **Conversation continuity:** Respond only to what's NEW in the latest client message. If Boss already said something similar, go deeper or move to the next step — don't repeat.
- **Pricing:** Never state dollar amounts, ranges, or monthly fees unless the mission brief includes approved pricing. When asked for numbers, outline scope and promise a written estimate — do not guess.
- Mention "discovery phase" at most once per meeting.

Provide your response in these clearly labeled sections only:

**Say this next:** [2-4 natural sentences Boss can say out loud. Direct opener. One unified solution thread.]

**Quick context:** [Only if Boss may not know a term — otherwise omit this section entirely.]

**Follow-up:** [One concrete question that advances the deal — not "schedule a follow-up" unless pricing/contract is next.]

No "Why it works" section.${buildMissionBrief(missionBrief)}`

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Full meeting transcript:\n${fullTranscriptText}

Latest exchange since last coaching (Boss + Client):\n${latestExchangeText}${buildRecentCoaching(history)}${intentGuidance}

Coach Boss on what to say next. One unified proposal — extend what was already discussed. Direct opener only. Answer the client's newest question first.`
    }
  ]

  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 380,
      temperature: 0.25,
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

    const sanitized = sanitizeCoachingResponse(accumulated, { allowPricing })
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
