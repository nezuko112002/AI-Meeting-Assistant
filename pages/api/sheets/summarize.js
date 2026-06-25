import OpenAI from 'openai'
import {
  buildSystemPrompt,
  SUMMARY_INSTRUCTION,
  parseSummaryResponse,
} from '../../../lib/buildAnalyzePrompt'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function getSpeakerLabel(speaker, speakerMap) {
  if (speakerMap?.[speaker]) return speakerMap[speaker]
  if (speaker === 'Boss' || speaker === 'Client') return speaker
  return `Speaker ${speaker}`
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json(parseSummaryResponse(''))
  }

  try {
    const {
      utterances,
      meetingTranscriptFromStart,
      speakerMap,
      knowledge = [],
      brief,
      company,
    } = req.body

    const fullMeetingUtterances = Array.isArray(meetingTranscriptFromStart) && meetingTranscriptFromStart.length > 0
      ? meetingTranscriptFromStart
      : utterances || []

    const merged = mergeConsecutiveUtterances(fullMeetingUtterances)
    const fullTranscriptText = buildTranscriptText(merged, speakerMap)
    const contextText = `${fullTranscriptText}\n${brief?.background || ''}\n${brief?.meetingGoal || ''}`

    const systemPrompt = buildSystemPrompt({ company, brief, knowledge, contextText })

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Full meeting transcript:\n${fullTranscriptText}\n\n${SUMMARY_INSTRUCTION}`,
        },
      ],
      max_tokens: 400,
      temperature: 0.2,
      stream: false,
    })

    const raw = completion.choices[0]?.message?.content || ''
    const parsed = parseSummaryResponse(raw)

    return res.status(200).json(parsed)
  } catch (err) {
    console.error('Summarize error:', err)
    return res.status(200).json(parseSummaryResponse(''))
  }
}
