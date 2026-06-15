import { useMemo } from 'react'

function normalizeSectionMarkers(text) {
  return text.replace(/\*\*([^*:]+):\*\*/g, '**$1**:')
}

function parseSections(text) {
  const sections = []
  const normalizedText = normalizeSectionMarkers(text)
  const regex = /\*\*([^*]+?)\*\*:?\s*([^]*?)(?=\s*\*\*[^*]+?\*\*:|$)/g
  let match
  while ((match = regex.exec(normalizedText)) !== null) {
    const heading = match[1].trim().replace(/:$/, '')
    const content = match[2].trim()
    if (content) sections.push({ heading, content })
  }
  if (sections.length === 0 && normalizedText.trim()) {
    sections.push({ heading: 'Say this next', content: normalizedText.trim() })
  }
  return sections.filter(s => s.heading.toLowerCase() !== 'why it works')
}

export function SuggestionCard({ text, isStreaming }) {
  const sections = useMemo(() => parseSections(text), [text])
  if (!text) return null
  return (
    <div className="rounded-xl border p-3 bg-green-50 border-green-200 animate-slide-up">
      {sections.map((s, i) => {
        return (
          <div key={i} className={i > 0 ? 'mt-4' : ''}>
            <p className="text-sm font-semibold mb-2 text-green-800">{s.heading}:</p>
            <p className="text-sm leading-relaxed text-green-900">
              {s.content}
              {isStreaming && i === sections.length - 1 && <span className="cursor-blink ml-0.5">▋</span>}
            </p>
          </div>
        )
      })}
    </div>
  )
}
