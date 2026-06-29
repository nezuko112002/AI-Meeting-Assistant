import { useState, useCallback, useRef, useEffect } from 'react'
import { useStreamingTranscription } from '../lib/useStreamingTranscription'
import { TranscriptBubble, getDefaultSpeakerLabel } from './TranscriptBubble'
import { SuggestionCard } from './SuggestionCard'
import { MicButton } from './MicButton'
import { AUDIENCE_LABELS } from '../lib/audienceLevel'
import { SpeakerMapEditor } from './SpeakerMapEditor'

const BRIEF_STORAGE_KEY = 'aiEarpiece_brief'
const EMPTY_BRIEF = {
  clientCompany: '',
  clientWebsite: '',
  priorConversations: '',
  audienceLevel: 'balanced',
}

function loadBriefFromStorage() {
  if (typeof window === 'undefined') return EMPTY_BRIEF
  try {
    const saved = localStorage.getItem(BRIEF_STORAGE_KEY)
    if (!saved) return EMPTY_BRIEF
    const parsed = JSON.parse(saved)
    const priorConversations = [parsed.priorConversations, parsed.background]
      .map(s => s?.trim())
      .filter(Boolean)
      .join('\n\n')
    return { ...EMPTY_BRIEF, ...parsed, priorConversations }
  } catch (_) {
    return EMPTY_BRIEF
  }
}

function mergeConsecutiveUtterances(existing = [], incoming = []) {
  const merged = existing.map(utterance => ({ ...utterance }))

  for (const utterance of incoming) {
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

function generateMeetingId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

const COMPANY_LABELS = {
  codeupscale: 'CodeUpscale',
  ridgetheory: 'Ridge Theory',
}

export function CopilotModal() {
  const [isProcessing, setIsProcessing] = useState(false)
  const [turns, setTurns] = useState([])
  const [history, setHistory] = useState([])
  const [pendingCoachingUtterances, setPendingCoachingUtterances] = useState([])
  const [speakers, setSpeakers] = useState([])
  const [speakerMap, setSpeakerMap] = useState({})
  const [showSpeakerEditor, setShowSpeakerEditor] = useState(false)
  const [showBriefPanel, setShowBriefPanel] = useState(true)
  const [company, setCompany] = useState('')
  const [companyError, setCompanyError] = useState(false)
  const [brief, setBrief] = useState(EMPTY_BRIEF)
  const [knowledge, setKnowledge] = useState([])
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [meetingId, setMeetingId] = useState(generateMeetingId)
  const [sessionStart, setSessionStart] = useState(null)
  const [isSavingLog, setIsSavingLog] = useState(false)
  const [logSaveStatus, setLogSaveStatus] = useState(null)
  const [meetingEnded, setMeetingEnded] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manualInput, setManualInput] = useState('')
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')
  const scrollRef = useRef(null)
  const meetingUtterancesRef = useRef([])
  const lastCoachedIndexRef = useRef(0)
  const hasRecordedRef = useRef(false)

  useEffect(() => {
    setBrief(loadBriefFromStorage())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(BRIEF_STORAGE_KEY, JSON.stringify(brief))
    } catch (_) {}
  }, [brief])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, status])

  const formatTranscriptText = useCallback((utterances) => {
    return utterances
      .map(u => `${speakerMap[u.speaker] || getDefaultSpeakerLabel(u.speaker)}: "${u.text}"`)
      .join('\n')
  }, [speakerMap])

  const getSpeakerLabel = useCallback((speaker) => {
    return speakerMap[speaker] || getDefaultSpeakerLabel(speaker)
  }, [speakerMap])

  const isClientUtterance = useCallback((utterance) => {
    const label = getSpeakerLabel(utterance?.speaker).trim().toLowerCase()
    if (utterance?.speaker === 'You' || utterance?.speaker === 'Boss' || label === 'boss' || label === 'you') return false
    return utterance?.speaker === 'Client' || label === 'client' || Boolean(utterance?.speaker)
  }, [getSpeakerLabel])

  const addTranscriptOnlyTurn = useCallback((utterances, { queueForCoaching = true } = {}) => {
    const mergedUtterances = mergeConsecutiveUtterances([], utterances)
    if (mergedUtterances.length === 0) return

    const newSpeakers = [...new Set(mergedUtterances.map(u => u.speaker))]
    setSpeakers(prev => {
      const merged = [...new Set([...prev, ...newSpeakers])]
      if (merged.length !== prev.length) setShowSpeakerEditor(true)
      return merged
    })

    meetingUtterancesRef.current = mergeConsecutiveUtterances(meetingUtterancesRef.current, mergedUtterances)
    setTurns(prev => {
      const lastTurn = prev[prev.length - 1]
      const lastUtterance = lastTurn?.utterances?.[lastTurn.utterances.length - 1]
      const firstIncoming = mergedUtterances[0]

      if (lastTurn && !lastTurn.suggestion && !lastTurn.isStreaming && lastUtterance?.speaker === firstIncoming?.speaker) {
        return prev.map((turn, index) =>
          index === prev.length - 1
            ? { ...turn, utterances: mergeConsecutiveUtterances(turn.utterances, mergedUtterances) }
            : turn
        )
      }

      return [...prev, { id: Date.now(), utterances: mergedUtterances, suggestion: '', isStreaming: false }]
    })
    setHistory(prev => [...prev, { role: 'user', content: formatTranscriptText(mergedUtterances) }])
    if (queueForCoaching) {
      const clientUtterances = mergedUtterances.filter(isClientUtterance)
      if (clientUtterances.length > 0) {
        setPendingCoachingUtterances(prev => mergeConsecutiveUtterances(prev, clientUtterances))
      }
    }
  }, [formatTranscriptText, isClientUtterance])

  const splitSpeakersIfNeeded = useCallback(async (utterances) => {
    if (!utterances || utterances.length !== 1) return utterances

    const [utterance] = utterances
    if (utterance.speaker === 'You' || utterance.speaker === 'Boss' || utterance.speaker === 'Client') return utterances
    if (!utterance?.text || utterance.text.split(/\s+/).length < 10) return utterances

    try {
      setStatus('Separating speakers...')
      const res = await fetch('/api/split-speakers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: utterance.text }),
      })
      const data = await res.json()
      if (!res.ok || !data.utterances?.length) return utterances
      return data.utterances
    } catch (_) {
      return utterances
    } finally {
      setStatus('')
    }
  }, [])

  const handleLiveTurn = useCallback(async (utterances) => {
    const speakerSplitUtterances = await splitSpeakersIfNeeded(utterances)
    addTranscriptOnlyTurn(speakerSplitUtterances)
  }, [addTranscriptOnlyTurn, splitSpeakersIfNeeded])

  const { isRecording, volume, error: micError, partialTranscript, setupStatus, start, stop } = useStreamingTranscription({
    onTurn: handleLiveTurn,
  })

  const fetchKnowledge = useCallback(async () => {
    setKnowledgeLoading(true)
    try {
      const res = await fetch('/api/sheets/knowledge?company=all')
      const data = await res.json()
      const rows = data.knowledge || []
      setKnowledge(rows)
      return rows
    } catch (_) {
      setKnowledge([])
      return []
    } finally {
      setKnowledgeLoading(false)
    }
  }, [])

  useEffect(() => {
    if (company) fetchKnowledge()
  }, [company, fetchKnowledge])

  const handleMicClick = useCallback(async () => {
    if (isRecording) {
      stop()
      return
    }

    if (!company) {
      setCompanyError(true)
      return
    }

    setCompanyError(false)

    if (!hasRecordedRef.current) {
      hasRecordedRef.current = true
      setSessionStart(Date.now())
      setShowBriefPanel(false)
    }

    if (!knowledge.length && !knowledgeLoading) {
      setStatus('Loading company context...')
      await fetchKnowledge()
      setStatus('')
    }

    start()
  }, [company, fetchKnowledge, isRecording, start, stop])

  const generateCoaching = useCallback(async (utterancesOverride) => {
    if (isProcessing) return

    const clientPartial = partialTranscript.filter(isClientUtterance)
    const sinceLastCoach = meetingUtterancesRef.current.slice(lastCoachedIndexRef.current)
    const utterances = utterancesOverride ?? mergeConsecutiveUtterances(
      sinceLastCoach.length > 0 ? sinceLastCoach : [...pendingCoachingUtterances],
      clientPartial
    )
    if (!utterances || utterances.length === 0) return

    const hasClientSpeech = utterances.some(isClientUtterance)
    if (!hasClientSpeech) return

    setIsProcessing(true)
    setError(null)

    let activeKnowledge = knowledge
    if (!activeKnowledge.length && company) {
      setStatus('Loading company context...')
      activeKnowledge = await fetchKnowledge()
      setStatus('Generating suggestions...')
    } else {
      setStatus('Generating suggestions...')
    }

    const turnId = Date.now()
    const fullContext = mergeConsecutiveUtterances(meetingUtterancesRef.current, partialTranscript)
    const meetingTranscriptFromStart = fullContext.length > 0 ? fullContext : utterances

    let coachingTurnId = turnId
    setTurns(prev => {
      const lastIdx = prev.length - 1
      const last = prev[lastIdx]
      if (last && !last.suggestion && !last.isStreaming && last.utterances?.length > 0) {
        coachingTurnId = last.id
        return prev.map((turn, index) =>
          index === lastIdx ? { ...turn, isStreaming: true } : turn
        )
      }
      return [...prev, { id: turnId, utterances: [], suggestion: '', isStreaming: true }]
    })

    try {
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utterances,
          meetingTranscriptFromStart,
          history,
          speakerMap,
          knowledge: activeKnowledge,
          brief,
          company,
        }),
      })

      if (!analyzeRes.ok) {
        if (analyzeRes.status === 204) {
          setTurns(prev => prev.map(t => t.id === coachingTurnId ? { ...t, isStreaming: false } : t))
          setIsProcessing(false)
          setStatus('')
          return
        }
        const err = await analyzeRes.json()
        setError(err.error || 'Analysis failed')
        setTurns(prev => prev.map(t => t.id === coachingTurnId ? { ...t, isStreaming: false } : t))
        setIsProcessing(false)
        setStatus('')
        return
      }

      let accumulated = ''
      const reader = analyzeRes.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            setTurns(prev => prev.map(t =>
              t.id === coachingTurnId ? { ...t, suggestion: accumulated, isStreaming: false } : t
            ))
            setHistory(prev => [...prev, { role: 'assistant', content: accumulated }])
            lastCoachedIndexRef.current = meetingUtterancesRef.current.length
            setPendingCoachingUtterances([])
            setIsProcessing(false)
            setStatus('')
            return
          }
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) {
              setError(parsed.error)
              setTurns(prev => prev.map(t =>
                t.id === coachingTurnId ? { ...t, isStreaming: false } : t
              ))
              setIsProcessing(false)
              setStatus('')
              return
            }
            if (parsed.replace) {
              accumulated = parsed.replace
              setTurns(prev => prev.map(t =>
                t.id === coachingTurnId ? { ...t, suggestion: accumulated } : t
              ))
            } else if (parsed.text) {
              accumulated += parsed.text
              setTurns(prev => prev.map(t =>
                t.id === coachingTurnId ? { ...t, suggestion: accumulated } : t
              ))
            }
          } catch (_) {}
        }
      }

      setTurns(prev => prev.map(t =>
        t.id === coachingTurnId ? { ...t, suggestion: accumulated, isStreaming: false } : t
      ))
      if (accumulated) {
        setHistory(prev => [...prev, { role: 'assistant', content: accumulated }])
        lastCoachedIndexRef.current = meetingUtterancesRef.current.length
        setPendingCoachingUtterances([])
      }
      setIsProcessing(false)
      setStatus('')
    } catch (err) {
      setError(err.message)
      setIsProcessing(false)
      setStatus('')
    }
  }, [brief, company, history, isClientUtterance, isProcessing, knowledge, partialTranscript, pendingCoachingUtterances, speakerMap])

  const handleEndMeeting = useCallback(async () => {
    setIsSavingLog(true)
    setLogSaveStatus('saving')
    setError(null)

    const fullContext = mergeConsecutiveUtterances(meetingUtterancesRef.current, partialTranscript)
    const meetingTranscriptFromStart = fullContext.length > 0 ? fullContext : meetingUtterancesRef.current

    let parsed = {
      summary: 'Meeting completed',
      topics: 'General discussion',
      actionItems: 'None noted',
      outcome: 'Completed',
    }

    try {
      const summarizeRes = await fetch('/api/sheets/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utterances: meetingTranscriptFromStart,
          meetingTranscriptFromStart,
          speakerMap,
          knowledge,
          brief,
          company,
        }),
      })
      const summaryData = await summarizeRes.json()
      parsed = summaryData
    } catch (_) {}

    const mins = sessionStart
      ? Math.round((Date.now() - sessionStart) / 60000)
      : 0
    const duration = `${mins} min${mins !== 1 ? 's' : ''}`

    try {
      const logRes = await fetch('/api/sheets/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company,
          meetingId,
          meetingType: 'General',
          clientName: 'Unknown',
          clientCompany: brief.clientCompany || 'Unknown',
          meetingGoal: 'Close the deal',
          duration,
          topics: parsed.topics,
          actionItems: parsed.actionItems,
          outcome: parsed.outcome,
          summary: parsed.summary,
        }),
      })
      const logData = await logRes.json()
      if (logData.success) {
        setLogSaveStatus('success')
      } else {
        setLogSaveStatus('error')
      }
    } catch (_) {
      setLogSaveStatus('error')
    } finally {
      setIsSavingLog(false)
      setMeetingEnded(true)
    }
  }, [brief, company, knowledge, meetingId, partialTranscript, sessionStart, speakerMap])

  const handleStartNewMeeting = useCallback(() => {
    meetingUtterancesRef.current = []
    lastCoachedIndexRef.current = 0
    hasRecordedRef.current = false
    setTurns([])
    setHistory([])
    setSpeakers([])
    setSpeakerMap({})
    setCompany('')
    setBrief(loadBriefFromStorage())
    setKnowledge([])
    setSessionStart(null)
    setLogSaveStatus(null)
    setMeetingEnded(false)
    setCompanyError(false)
    setMeetingId(generateMeetingId())
    setKnowledgeLoading(false)
    setShowBriefPanel(true)
    setError(null)
    setStatus('')
    setPendingCoachingUtterances([])
  }, [])

  const clientPartialUtterances = partialTranscript.filter(isClientUtterance)
  const hasClientSpeechReady = pendingCoachingUtterances.length > 0 || clientPartialUtterances.length > 0
  const generateEnabled = isRecording || hasClientSpeechReady
  const showBriefing = showBriefPanel && !meetingEnded && (turns.length === 0 || sessionStart !== null)
  const companyLocked = sessionStart !== null

  const handleSpeakerChange = useCallback((speaker, name) => {
    setSpeakerMap(prev => ({ ...prev, [speaker]: name }))
  }, [])

  const processManual = useCallback(async (text) => {
    addTranscriptOnlyTurn([{ speaker: 'Client', text }])
  }, [addTranscriptOnlyTurn])

  const updateBrief = useCallback((field, value) => {
    setBrief(prev => ({ ...prev, [field]: value }))
  }, [])

  const activeError = error || micError

  const footerStatus = () => {
    if (logSaveStatus === 'saving') return 'Saving to Meeting Log...'
    if (logSaveStatus === 'success') return '✅ Saved to Meeting Log'
    if (logSaveStatus === 'error') return '⚠️ Could not save — check Sheets connection'
    if (knowledgeLoading) return 'Loading company context...'
    if (hasClientSpeechReady) {
      const count = pendingCoachingUtterances.length + clientPartialUtterances.length
      return `${count} client part${count !== 1 ? 's' : ''} ready${clientPartialUtterances.length > 0 && pendingCoachingUtterances.length === 0 ? ' (live)' : ''}`
    }
    if (isRecording) return 'Listening — Generate when client speaks'
    if (speakers.length > 0) {
      return `${speakers.length} speaker${speakers.length !== 1 ? 's' : ''} · ${turns.length} exchange${turns.length !== 1 ? 's' : ''}`
    }
    return 'Ready'
  }

  return (
    <div className="font-sans w-full h-full min-h-0 flex flex-col">
      <div
        className="bg-white rounded-3xl shadow-2xl border border-white/20 overflow-hidden flex flex-col"
        style={{ height: '100%', minHeight: 0 }}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2 px-5 py-4 bg-slate-900 select-none">
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-400 listening-ring' : isProcessing ? 'bg-amber-400 listening-ring' : 'bg-slate-500'}`} />
          <span className="text-white text-sm font-medium flex-1 flex items-center gap-2 flex-wrap">
            AI Earpiece
            {sessionStart && company && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                company === 'codeupscale' ? 'bg-violet-600 text-white' : 'bg-sky-600 text-white'
              }`}>
                {COMPANY_LABELS[company]}
              </span>
            )}
            {isRecording && <span className="text-red-300 text-xs">● Listening</span>}
            {isProcessing && !isRecording && <span className="text-amber-300 text-xs">● Processing</span>}
          </span>
          <div className="flex items-center gap-1">
            {speakers.length > 0 && (
              <button
                onClick={() => setShowSpeakerEditor(v => !v)}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded transition-colors"
                title="Name speakers"
              >
                Speakers
              </button>
            )}
            {sessionStart !== null && !meetingEnded && (
              <button
                onClick={() => setShowBriefPanel(v => !v)}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded transition-colors"
                title="Mission brief"
              >
                📋 Brief
              </button>
            )}
            <button
              onClick={() => setShowManual(v => !v)}
              className="text-slate-400 hover:text-white p-1 rounded transition-colors"
              title="Type manually"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Mission Brief */}
        {showBriefing && (
          <div className="flex-shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
              </svg>
              <p className="text-xs font-semibold text-slate-600">Mission Brief</p>
            </div>

            <label className="block text-[11px] font-medium text-slate-500 mb-1">Meeting is for</label>
            <select
              value={company}
              onChange={e => { setCompany(e.target.value); setCompanyError(false) }}
              disabled={companyLocked}
              className={`w-full text-xs border rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white ${
                companyLocked ? 'opacity-50 cursor-not-allowed bg-slate-100' : 'border-slate-200'
              } ${companyError ? 'border-red-400' : ''}`}
            >
              <option value="" disabled>Select a company...</option>
              <option value="codeupscale">CodeUpscale</option>
              <option value="ridgetheory">Ridge Theory</option>
            </select>
            {companyError && (
              <p className="text-[11px] text-red-500 mt-1">Please select a company first</p>
            )}

            <label className="block text-[11px] font-medium text-slate-500 mt-3 mb-1">Who is the client?</label>
            <select
              value={brief.audienceLevel || 'balanced'}
              onChange={e => updateBrief('audienceLevel', e.target.value)}
              disabled={companyLocked}
              className={`w-full text-xs border rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white ${
                companyLocked ? 'opacity-50 cursor-not-allowed bg-slate-100' : 'border-slate-200'
              }`}
            >
              {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">
              Developer = stack names and protocols. Executive = plain language and outcomes.
            </p>

            <label className="block text-[11px] font-medium text-slate-500 mt-3 mb-1">Client company</label>
            <input
              type="text"
              value={brief.clientCompany}
              onChange={e => updateBrief('clientCompany', e.target.value)}
              placeholder="e.g. Acme Corp"
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
            />

            <label className="block text-[11px] font-medium text-slate-500 mt-3 mb-1">Client website</label>
            <input
              type="url"
              value={brief.clientWebsite}
              onChange={e => updateBrief('clientWebsite', e.target.value)}
              placeholder="https://echologistics.com"
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
            />

            <label className="block text-[11px] font-medium text-slate-500 mt-3 mb-1">Prior conversations &amp; prep notes</label>
            <textarea
              value={brief.priorConversations}
              onChange={e => updateBrief('priorConversations', e.target.value)}
              placeholder="LinkedIn DMs, email threads, past calls, rep notes — anything you already know about this client..."
              rows={4}
              className="w-full resize-none text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
            />
            <p className="text-xs text-slate-400 mt-1">{brief.priorConversations.length} characters</p>
          </div>
        )}

        {showSpeakerEditor && (
          <div className="flex-shrink-0">
            <SpeakerMapEditor
              speakers={speakers}
              speakerMap={speakerMap}
              onChange={handleSpeakerChange}
            />
          </div>
        )}

        {showManual && (
          <div className="flex-shrink-0 px-4 pt-3 pb-0">
            <div className="flex gap-2">
              <input
                type="text"
                value={manualInput}
                onChange={e => setManualInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { const t = manualInput.trim(); if (t) { setManualInput(''); setShowManual(false); processManual(t) } } }}
                placeholder="Type what was said..."
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none focus:border-slate-400 bg-slate-50"
                autoFocus
              />
              <button
                onClick={() => { const t = manualInput.trim(); if (t) { setManualInput(''); setShowManual(false); processManual(t) } }}
                disabled={!manualInput.trim()}
                className="px-3 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-40 hover:bg-slate-700 transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        )}

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 px-4 pt-3 pb-2 space-y-4 overflow-y-auto"
        >
          {turns.length === 0 && !activeError && !meetingEnded && (
            <div className="py-6 text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                  <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="22"/>
                </svg>
              </div>
              <p className="text-sm text-slate-500 font-medium">Ready to pitch</p>
              <p className="text-xs text-slate-400 mt-1">Select a company, fill the brief, then press mic</p>
              <p className="text-xs text-slate-300 mt-0.5">You = our team · Client = the company we are selling to</p>
            </div>
          )}

          {meetingEnded && (
            <div className="py-6 text-center">
              <p className="text-sm text-slate-500 font-medium">Meeting ended</p>
              <p className="text-xs text-slate-400 mt-1">
                {logSaveStatus === 'success'
                  ? 'Summary saved to Meeting Log'
                  : logSaveStatus === 'error'
                  ? 'Summary could not be saved — check Sheets connection'
                  : 'Session complete'}
              </p>
            </div>
          )}

          {activeError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-sm text-red-700">{activeError}</p>
            </div>
          )}

          {!meetingEnded && turns.map(turn => (
            <div key={turn.id} className="space-y-2">
              <TranscriptBubble utterances={turn.utterances} speakerMap={speakerMap} />
              {turn.suggestion && (
                <SuggestionCard text={turn.suggestion} isStreaming={turn.isStreaming} />
              )}
            </div>
          ))}
        </div>

        {!meetingEnded && (status || setupStatus || partialTranscript.length > 0) && (
          <div className="flex-shrink-0 px-4 py-2 border-t border-slate-100 bg-white space-y-2">
            {status && !activeError && (
              <div className="flex items-center gap-2 px-1 py-1">
                <div className="flex gap-1">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 bg-slate-300 rounded-full"
                      style={{ animation: `pulse-dot 1.2s ease-in-out ${i * 0.2}s infinite` }} />
                  ))}
                </div>
                <span className="text-xs text-slate-400">{status}</span>
              </div>
            )}

            {setupStatus && !activeError && (
              <div className="bg-cyan-50 border border-cyan-200 rounded-xl p-3">
                <p className="text-sm text-cyan-800">{setupStatus}</p>
                <p className="text-xs text-cyan-600 mt-1">
                  Choose the Zoom/Meet tab or window and make sure audio sharing is enabled.
                </p>
              </div>
            )}

            {partialTranscript.length > 0 && !activeError && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-400 listening-ring" />
                  <span className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Live transcript</span>
                </div>
                <TranscriptBubble utterances={partialTranscript} speakerMap={speakerMap} />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100 bg-slate-50">
          {meetingEnded ? (
            <button
              onClick={handleStartNewMeeting}
              className="w-full py-2.5 bg-slate-800 text-white text-sm font-semibold rounded-xl hover:bg-slate-700 transition-colors"
            >
              Start New Meeting
            </button>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-slate-400 min-w-0 truncate">
                {footerStatus()}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {turns.length > 0 && !isRecording && (
                  <button
                    onClick={handleEndMeeting}
                    disabled={isSavingLog || isProcessing}
                    className="px-3 py-2 text-rose-600 border border-rose-200 text-xs font-semibold rounded-full hover:bg-rose-50 disabled:opacity-40 transition-colors"
                  >
                    End Meeting
                  </button>
                )}
                <button
                  onClick={() => generateCoaching()}
                  disabled={isProcessing || !generateEnabled || isSavingLog}
                  className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-full disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-500 transition-colors"
                  title="Generate what to say next — active while listening; only responds to client speech"
                >
                  Generate
                </button>
                <MicButton
                  isRecording={isRecording}
                  isProcessing={isProcessing || isSavingLog}
                  volume={volume}
                  onClick={handleMicClick}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
