const FLUFF_OPENER_PATTERNS = [
  /^To (enhance|address|automate|streamline|implement|create|build|tackle|solve|reduce|improve|help|ensure|provide|develop|integrate|offer|deliver|eliminate|mitigate|optimize)[^,]*,\s*/i,
  /^Yes\s*[—–-]\s*/i,
  /^We (can|recommend|suggest|would|believe)\s+/i,
  /^(Absolutely|Great question|That makes sense|Totally fair|Of course|Certainly)[,.!]?\s*/i,
]

const FLUFF_PHRASE_PATTERNS = [
  /\bI understand (the|your|that)[^.?!]*[.?!]?\s*/gi,
  /\bI appreciate your[^.?!]*[.?!]?\s*/gi,
  /\bWe understand (that |the )?[^.?!]*[.?!]?\s*/gi,
  /\bOur approach (is|focuses on|will)[^.?!]*[.?!]?\s*/gi,
  /\bThis (allows us|ensures|helps us|is designed) to[^.?!]*[.?!]?\s*/gi,
  /\bThis way,?\s*(we|you)[^.?!]*[.?!]?\s*/gi,
  /\bIn the meantime,?\s*[^.?!]*[.?!]?\s*/gi,
  /\bI(?:'ll| will) provide a (?:detailed )?written (?:estimate|proposal)[^.?!]*[.?!]?\s*/gi,
  /\b(?:We can|I'll) send (?:over )?a (?:detailed )?(?:written )?(?:estimate|proposal)[^.?!]*[.?!]?\s*/gi,
  /\bOur commitment (?:to|is)[^.?!]*[.?!]?\s*/gi,
  /\bis backed by our[^.?!]*[.?!]?\s*/gi,
  /\bminimizing risk[^.?!]*[.?!]?\s*/gi,
  /\bhelp(?:s)? (?:manage|reduce) costs[^.?!]*[.?!]?\s*/gi,
  /\bensuring (?:we|you|that)[^.?!]*[.?!]?\s*/gi,
  /\bwhich (?:allows|ensures|helps)[^.?!]*[.?!]?\s*/gi,
  /\b(?:generally|typically|usually),?\s*/gi,
  /\bwe(?:'re| are) (?:confident|committed)[^.?!]*[.?!]?\s*/gi,
  /\b(?:focuses on|focused on) delivering[^.?!]*[.?!]?\s*/gi,
  /\bdelivering a phased (?:solution|approach)[^.?!]*[.?!]?\s*/gi,
  /\bwithout requiring[^.?!]*[.?!]?\s*/gi,
  /\band that's where we come in[^.?!]*[.?!]?\s*/gi,
  /\bTo ensure transparency,?\s*/gi,
  /\blaying the groundwork for[^.?!]*[.?!]?\s*/gi,
  /\bto guarantee accountability[^.?!]*[.?!]?\s*/gi,
  /\bWe will also set[^.?!]*[.?!]?\s*/gi,
  /\bwhile (?:laying|providing|ensuring)[^.?!]*[.?!]?\s*/gi,
  /,\s*similar to our [^.?!]*(?:business finance|fintech|banking|trucking|logistics|freight|dispatch)[^.?!]*[.?!]?\s*/gi,
  /\bThis phased approach allows[^.?!]*[.?!]?\s*/gi,
  /\breducing risk compared to[^.?!]*[.?!]?\s*/gi,
  /\ballows for a quicker go-live[^.?!]*[.?!]?\s*/gi,
  /\bthroughout the process[^.?!]*[.?!]?\s*/gi,
  /\bThis structured approach builds[^.?!]*[.?!]?\s*/gi,
  /\bbuilds trust and accountability[^.?!]*[.?!]?\s*/gi,
  /\bkeep you (?:updated|aligned)[^.?!]*[.?!]?\s*/gi,
  /\bensure you(?:'re| are) aligned[^.?!]*[.?!]?\s*/gi,
  /\bI can'?t provide details about (?:your|the) company[^.?!]*[.?!]?\s*/gi,
  /\bI cannot provide details about[^.?!]*[.?!]?\s*/gi,
  /\bI'?m not able to (?:share|provide) (?:details|information) about (?:your|the) company[^.?!]*[.?!]?\s*/gi,
]

const FLUFF_SENTENCE_CONTAINS = /\b(phased approach|structured approach|reducing risk compared|builds trust|aligned throughout|allows for a quicker go-live|which focused on a web application)\b/i

function capitalizeFirst(text) {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function collapseWhitespace(text) {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*([.!?])+/g, '$1')
    .replace(/^\s*[,—–-]\s*/, '')
    .replace(/\s+[,—–-]\s*$/g, '')
    .trim()
}

export function dropFluffSentences(text = '') {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)

  const kept = sentences.filter(s => {
    if (FLUFF_SENTENCE_CONTAINS.test(s)) return false
    if (/\bI can'?t provide details\b/i.test(s)) return false
    if (/\bI cannot provide details\b/i.test(s)) return false
    return !/^(this (phased|structured) approach|this allows|reducing risk|builds trust|throughout the process|allows for a quicker|weekly demos will ensure)/i.test(s)
  })
  return kept.join(' ').trim()
}

export function stripFluffFromText(text = '') {
  if (!text) return text

  let cleaned = text.trim()

  for (let pass = 0; pass < 4; pass++) {
    const before = cleaned
    for (const pattern of FLUFF_OPENER_PATTERNS) {
      cleaned = cleaned.replace(pattern, '')
    }
    for (const pattern of FLUFF_PHRASE_PATTERNS) {
      cleaned = cleaned.replace(pattern, '')
    }
    cleaned = collapseWhitespace(cleaned)
    if (cleaned === before) break
  }

  cleaned = cleaned
    .replace(/\bYes\s*[—–-]\s*(?=[A-Z])/g, '')
    .replace(/\.\s+and\s+\./gi, '.')
    .replace(/\s+\./g, '.')

  return capitalizeFirst(collapseWhitespace(dropFluffSentences(cleaned))) || text.trim()
}

export function tightenToDirectSpeech(text = '', { maxSentences = 3 } = {}) {
  const stripped = stripFluffFromText(text)
  if (!stripped) return stripped

  const sentences = stripped
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)

  if (sentences.length <= maxSentences) return stripped

  return sentences.slice(0, maxSentences).join(' ')
}
