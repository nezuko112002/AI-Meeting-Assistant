import { useState, useCallback, useRef, useEffect } from 'react'
import { useStreamingTranscription } from '../lib/useStreamingTranscription'
import { TranscriptBubble, getDefaultSpeakerLabel } from './TranscriptBubble'
import { SuggestionCard } from './SuggestionCard'
import { MicButton } from './MicButton'
import { SpeakerMapEditor } from './SpeakerMapEditor'

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

export function CopilotModal() {
  const [isProcessing, setIsProcessing] = useState(false)
  const [turns, setTurns]               = useState([])
  const [history, setHistory]           = useState([])
  const [pendingCoachingUtterances, setPendingCoachingUtterances] = useState([])
  const [speakers, setSpeakers]         = useState([])
  const [speakerMap, setSpeakerMap]     = useState({})
  const [showSpeakerEditor, setShowSpeakerEditor] = useState(false)
  const [showMissionBrief, setShowMissionBrief] = useState(true)
  const [missionBrief, setMissionBrief] = useState({
    clientName: '',
    company: '',
    meetingAbout: '',
    background: '',
  })
  const [showManual, setShowManual]     = useState(false)
  const [manualInput, setManualInput]   = useState('')
  const [error, setError]               = useState(null)
  const [status, setStatus]             = useState('')
  const scrollRef = useRef(null)
  const meetingUtterancesRef = useRef([])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, status])

  // ── Audio / AI logic ──────────────────────────────────────────────────────
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
    if (utterance?.speaker === 'Boss' || label === 'boss') return false
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

  const generateCoaching = useCallback(async (utterances = pendingCoachingUtterances) => {
    if (!utterances || utterances.length === 0) return

    const hasClientSpeech = utterances.some(isClientUtterance)
    if (!hasClientSpeech) {
      setError('No client speech is ready to coach yet.')
      return
    }

    setIsProcessing(true)
    setError(null)
    setStatus('Generating suggestions...')

    const turnId = Date.now()
    const meetingTranscriptFromStart = meetingUtterancesRef.current.length > 0
      ? meetingUtterancesRef.current
      : utterances
    setTurns(prev => [...prev, { id: turnId, utterances: [], suggestion: '', isStreaming: true }])

    try {
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterances, meetingTranscriptFromStart, history, speakerMap, missionBrief }),
      })

      if (!analyzeRes.ok) {
        const err = await analyzeRes.json()
        setError(err.error || 'Analysis failed')
        setTurns(prev => prev.map(t => t.id === turnId ? { ...t, isStreaming: false } : t))
        setIsProcessing(false); setStatus(''); return
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
              t.id === turnId ? { ...t, suggestion: accumulated, isStreaming: false } : t
            ))
            const transcriptText = formatTranscriptText(utterances)
            setHistory(prev => [
              ...prev,
              { role: 'user', content: transcriptText },
              { role: 'assistant', content: accumulated },
            ])
            setPendingCoachingUtterances([])
            setIsProcessing(false); setStatus(''); return
          }
          try {
            const parsed = JSON.parse(data)
            if (parsed.text) {
              accumulated += parsed.text
              setTurns(prev => prev.map(t =>
                t.id === turnId ? { ...t, suggestion: accumulated } : t
              ))
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      setError(err.message)
      setIsProcessing(false); setStatus('')
    }
  }, [formatTranscriptText, history, isClientUtterance, missionBrief, pendingCoachingUtterances, speakerMap])

  const splitSpeakersIfNeeded = useCallback(async (utterances) => {
    if (!utterances || utterances.length !== 1) return utterances

    const [utterance] = utterances
    if (utterance.speaker === 'Boss' || utterance.speaker === 'Client') return utterances
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

  const handleSpeakerChange = useCallback((speaker, name) => {
    setSpeakerMap(prev => ({ ...prev, [speaker]: name }))
  }, [])

  const processManual = useCallback(async (text) => {
    addTranscriptOnlyTurn([{ speaker: 'Client', text }])
  }, [addTranscriptOnlyTurn])

  const activeError = error || micError

  return (
    <div className="font-sans w-full h-full min-h-0 flex flex-col">
      <div
        className="bg-white rounded-3xl shadow-2xl border border-white/20 overflow-hidden flex flex-col"
        style={{ height: '100%', minHeight: 0 }}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2 px-5 py-4 bg-slate-900 select-none">
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-400 listening-ring' : isProcessing ? 'bg-amber-400 listening-ring' : 'bg-slate-500'}`} />
          <span className="text-white text-sm font-medium flex-1">
            Meeting Copilot
            {isRecording && <span className="text-red-300 text-xs ml-2">● Listening</span>}
            {isProcessing && !isRecording && <span className="text-amber-300 text-xs ml-2">● Processing</span>}
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
            {turns.length > 0 && (
              <button
                onClick={() => { meetingUtterancesRef.current = []; setPendingCoachingUtterances([]); setTurns([]); setHistory([]); setSpeakers([]); setSpeakerMap({}); setError(null) }}
                className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setShowMissionBrief(v => !v)}
              className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded transition-colors"
              title="Mission brief"
            >
              Brief
            </button>
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

        <>
            {/* Mission brief */}
            {showMissionBrief && turns.length === 0 && (
              <div className="flex-shrink-0 border-b border-slate-100 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-xs font-semibold text-slate-600">Mission Brief</p>
                    <p className="text-[11px] text-slate-400">Optional context for more relevant coaching.</p>
                  </div>
                  <button
                    onClick={() => setShowMissionBrief(false)}
                    className="text-xs text-slate-400 hover:text-slate-600"
                  >
                    Hide
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="text"
                    value={missionBrief.clientName}
                    onChange={e => setMissionBrief(prev => ({ ...prev, clientName: e.target.value }))}
                    placeholder="Client name"
                    className="text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
                  />
                  <input
                    type="text"
                    value={missionBrief.company}
                    onChange={e => setMissionBrief(prev => ({ ...prev, company: e.target.value }))}
                    placeholder="Company"
                    className="text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
                  />
                </div>
                <input
                  type="text"
                  value={missionBrief.meetingAbout}
                  onChange={e => setMissionBrief(prev => ({ ...prev, meetingAbout: e.target.value }))}
                  placeholder="What is this meeting about?"
                  className="mt-2 w-full text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
                />
                <textarea
                  value={missionBrief.background}
                  onChange={e => setMissionBrief(prev => ({ ...prev, background: e.target.value }))}
                  placeholder="Background, goals, constraints, things the AI should know..."
                  rows={2}
                  className="mt-2 w-full resize-none text-xs border border-slate-200 rounded-lg px-2 py-2 outline-none focus:border-slate-400 bg-white"
                />
              </div>
            )}

            {/* Speaker name editor */}
            {showSpeakerEditor && (
              <div className="flex-shrink-0">
                <SpeakerMapEditor
                  speakers={speakers}
                  speakerMap={speakerMap}
                  onChange={handleSpeakerChange}
                />
              </div>
            )}

            {/* Manual input */}
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

            {/* Content — flex-1 so it fills remaining height */}
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 px-4 pt-3 pb-2 space-y-4 overflow-y-auto"
            >
              {turns.length === 0 && !activeError && (
                <div className="py-6 text-center">
                  <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                      <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                  </div>
                  <p className="text-sm text-slate-500 font-medium">Ready for your meeting</p>
                  <p className="text-xs text-slate-400 mt-1">Press mic once · share the meeting tab/window with audio</p>
                  <p className="text-xs text-slate-300 mt-0.5">Boss mic and client audio are captured separately</p>
                </div>
              )}

              {activeError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <p className="text-sm text-red-700">{activeError}</p>
                </div>
              )}

              {status && !activeError && (
                <div className="flex items-center gap-2 px-1 py-1">
                  <div className="flex gap-1">
                    {[0,1,2].map(i => (
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

              {turns.map(turn => (
                <div key={turn.id} className="space-y-2">
                  <TranscriptBubble utterances={turn.utterances} speakerMap={speakerMap} />
                  {turn.suggestion && (
                    <SuggestionCard text={turn.suggestion} isStreaming={turn.isStreaming} />
                  )}
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="text-xs text-slate-400">
                {pendingCoachingUtterances.length > 0
                  ? `${pendingCoachingUtterances.length} client part${pendingCoachingUtterances.length !== 1 ? 's' : ''} ready`
                  : speakers.length > 0
                  ? `${speakers.length} speaker${speakers.length !== 1 ? 's' : ''} · ${turns.length} exchange${turns.length !== 1 ? 's' : ''}`
                  : 'Powered by AssemblyAI + GPT-4o'
                }
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => generateCoaching()}
                  disabled={isProcessing || pendingCoachingUtterances.length === 0}
                  className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-full disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-500 transition-colors"
                  title="Generate what to say next from the client speech so far"
                >
                  Generate
                </button>
                <MicButton
                  isRecording={isRecording}
                  isProcessing={isProcessing}
                  volume={volume}
                  onClick={isRecording ? stop : start}
                />
              </div>
            </div>
        </>
      </div>
    </div>
  )
}
