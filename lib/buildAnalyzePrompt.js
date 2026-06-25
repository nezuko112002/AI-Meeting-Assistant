import {
  buildRelevantKnowledgeSection,
  buildPricingBasisSection,
  buildAllowedNamesSection,
  buildPriceEstimateSection,
  findRelevantProjects,
  getKnowledgeCompanyNames,
} from './knowledgeHelpers'
import { buildPortfolioFirewallSection } from './prospectAttribution'

const COMPANY_DISPLAY_NAMES = {
  codeupscale: 'CodeUpscale',
  ridgetheory: 'Ridge Theory',
}

function buildVoiceExamples() {
  return `
Voice — blunt and speakable only:
- "Phase one is the patient portal — booking, login, and messaging. Not the full platform."
- "Closest match is [PAST CLIENT FROM SPREADSHEET] — [scope from sheet]."
- "Phase one is $18,000 to $22,000 — same scope as our CareCloud build: booking, portal, admin."
- "I'm your account lead. Week one: kickoff and workflow mapping with ops."

Banned — never write these (anywhere in the response):
- Empathy/validation: "Yes —", "I understand", "We understand", "Great question", "That makes sense", "Absolutely"
- Agency filler: "Our approach", "This ensures", "ensuring you", "minimizing risk", "delivering a phased solution"
- Deferrals: "I'll provide a written estimate", "In the meantime", "24-48 hours" (unless client already agreed and you are closing)
- Refusals: "I can't provide details about your company", "I'm not able to share information about your company"
- Soft openers: "To enhance...", "We can create...", "We recommend..."
- Invented past client names`
}

export function buildCompanyIdentitySection(company) {
  const displayName = COMPANY_DISPLAY_NAMES[company] || 'the company'
  return `You are the AI meeting copilot for ${displayName}.`
}

export function buildBriefSection(brief) {
  if (!brief) return ''

  const lines = []
  if (brief.clientCompany) lines.push(`Prospect company (on this call): ${brief.clientCompany}`)
  if (brief.clientWebsite) lines.push(`Client website: ${brief.clientWebsite}`)
  if (brief.websiteSnippet) lines.push(`Website summary (scraped): ${brief.websiteSnippet}`)
  if (brief.priorConversations) {
    lines.push(`Prior conversations & prep notes (treat as facts the rep already knows):\n${brief.priorConversations}`)
  }

  if (!lines.length) return ''

  return `MEETING BRIEF:
${lines.join('\n')}`
}

export function buildCoreCoachingInstructions() {
  return `You are a silent real-time sales meeting coach for a software and web development agency.

**Who we are:** We build custom software and redesign/develop websites for other companies. We are the vendor; the company on the other side of the call is the client (prospect or buyer). Our job in every meeting is to win their project.

**Who is on the call:** "You" is our salesperson (our side). "Client" is the prospect company. Coach You on what to say to win the deal.

**Goal:** Move toward a signed SOW — learn their stack and pain when needed, handle objections, state price when asked, and close when they're ready.
When client agrees to receive a proposal ("send it", "if the numbers work"), switch to CLOSE MODE — confirm deliverable, timeline, recipients, and next meeting.

**One evolving proposal:** This meeting builds ONE solution — a single platform or project scope that grows turn by turn. Read the full transcript, infer what we've already proposed, and EXTEND that thread. Never restart with an unrelated product.
Do NOT invent pain points. Reference past work ONLY as portfolio proof ("we built X for [past client]") after the client has described their situation — never as the prospect's stated needs.

Two core objectives — every response must satisfy both:
1. **Expertise:** Name real tools, stacks, and architectures. Tie every point to what the client said in THIS meeting.
2. **Persuasion:** Move toward a signed SOW. Propose phases, reduce risk, ask one sharp closing question.

${buildVoiceExamples()}

Writing rules — zero fluff:
- **Say this next:** 1-3 short sentences. First word is the answer (price, name, module, date). No preamble.
- Every sentence must contain a fact: dollar amount, client name from sheet, module name, deadline, or next step.
- No hedging words: generally, typically, we believe, our commitment, helps manage, ensures.
- **Answer every distinct question** in the client's latest message. Do not skip pricing, credibility, ownership, timeline, or competitor parts.
- **Conversation continuity:** Respond only to what's NEW in the client's latest message. Never recycle a sentence from prior coaching.
- If phase-one price was already stated, do not repeat the dollar amount unless the client asked for price again.
- **Follow-up:** One short question. Never repeat a follow-up question from earlier in this meeting.
- **Portfolio rule:** Cite spreadsheet clients as past work we delivered. Never describe them as the prospect's systems unless the client or prep notes said so.
- **Company knowledge:** When asked what you know about the prospect, use MEETING BRIEF prep notes and website first — max 2 short speakable sentences. Put questions in Follow-up only. Never refuse with "I can't provide details".
- **Industry experience:** When asked if you've worked in their industry, name 2 ALLOWED PAST CLIENT NAMES and the scope we built — required, not optional.

Provide your response in these two sections only:

**Say this next:** [1-3 sentences You read aloud verbatim.]

**Follow-up:** [One question.]

No Quick context section. No "Why it works" section.`
}

export function buildSystemPrompt({
  company,
  brief,
  knowledge = [],
  contextText = '',
}) {
  const relevantProjects = findRelevantProjects(knowledge, contextText, brief)
  const meetingContext = contextText.toLowerCase()

  const sections = [
    buildCompanyIdentitySection(company),
    buildPortfolioFirewallSection(knowledge, brief),
    buildAllowedNamesSection(knowledge, brief?.clientCompany),
    buildRelevantKnowledgeSection(relevantProjects),
    buildPricingBasisSection(knowledge, relevantProjects, meetingContext),
    buildPriceEstimateSection(knowledge, relevantProjects, contextText),
    buildBriefSection(brief),
    buildCoreCoachingInstructions(),
  ].filter(Boolean)

  return sections.join('\n\n')
}

export function getKnowledgeContextForSanitize(knowledge = []) {
  return getKnowledgeCompanyNames(knowledge)
}

export const SUMMARY_INSTRUCTION = `Based on the full meeting transcript above, respond ONLY with a valid JSON object — no markdown, no explanation, just JSON:
{
  "summary": "2-3 sentence summary of what was discussed",
  "topics": "comma-separated key topics",
  "actionItems": "semicolon-separated action items or none",
  "outcome": "one sentence on overall outcome or sentiment"
}`

export function parseSummaryResponse(raw) {
  const fallbacks = {
    summary: 'Meeting completed',
    topics: 'General discussion',
    actionItems: 'None noted',
    outcome: 'Completed',
  }

  if (!raw) return fallbacks

  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      summary: parsed.summary || fallbacks.summary,
      topics: parsed.topics || fallbacks.topics,
      actionItems: parsed.actionItems || fallbacks.actionItems,
      outcome: parsed.outcome || fallbacks.outcome,
    }
  } catch (_) {
    return fallbacks
  }
}
