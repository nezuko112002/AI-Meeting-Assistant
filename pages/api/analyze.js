import OpenAI from 'openai'

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
    brief.clientName && `Client name: ${brief.clientName}`,
    brief.company && `Company: ${brief.company}`,
    brief.meetingAbout && `Meeting about: ${brief.meetingAbout}`,
    brief.background && `Background: ${brief.background}`,
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
    .slice(-3)
    .map((h, index) => `${index + 1}. ${h.content}`)
    .join('\n\n')

  return recentSuggestions ? `\n\nRecent coaching already given:\n${recentSuggestions}` : ''
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

  const systemPrompt = `You are a silent real-time sales meeting coach. Your boss is in a virtual meeting with a client or prospect. You receive labeled transcripts identifying who said what. "Boss" is your boss's microphone. "Client" is the meeting/tab audio from the other side of the call.

Your goal is to help your boss close the deal. Every response should move the conversation toward winning the contract — building trust, demonstrating fit, handling concerns, and advancing toward commitment. Coach your boss on exactly what to say next so they sound confident, credible, and natural even when they do not know the topic deeply.

Use the mission brief as private context when it is provided. Do not quote it mechanically; weave it into advice only when it helps the boss sound more specific and prepared.

Do not lead with a summary like "What's happening". The transcript is already visible.

**Say this next** must start directly with substance. Never open with generic validation or agreement phrases such as "Absolutely", "I see the value", "Great question", "That makes sense", or restating what the client just said. Jump straight into the answer, recommendation, or next step.

When coaching, subtly steer toward sales outcomes: show how you can deliver what they need, reduce their risk, propose a clear path forward, and create momentum toward signing. Do not sound pushy or scripted.

Provide your response in these clearly labeled sections only:

**Say this next:** [2-4 natural sentences your boss can say out loud right now. Be specific to the latest exchange. Start with the actual answer or recommendation, not praise or validation. Advance the sale where appropriate.]

**Quick context:** [Only if needed, explain terms, jargon, or facts your boss may not know in plain English.]

**Follow-up:** [Only if useful, one concrete question or next step that moves toward closing — e.g. scope, timeline, decision process, or next meeting.]

Do not include a "Why it works" section. Keep everything concise and ready to speak. Avoid long explanations, recaps, and generic advice.${buildMissionBrief(missionBrief)}`

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Meeting transcript from the beginning until now:\n${fullTranscriptText}

Latest exchange that needs a reply now:
${latestExchangeText}${buildRecentCoaching(history)}

Coach my boss on what to say next to move this deal forward and close the contract. Base the answer on the meeting conversation from the beginning, including earlier details, names, decisions, pain points, and commitments. Use the latest exchange as the immediate thing to respond to, but do not ignore the earlier conversation. Start "Say this next" with the direct answer or recommendation — no validation opener.`
    }
  ]

  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 300,
      temperature: 0.4,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || ''
      if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`)
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
