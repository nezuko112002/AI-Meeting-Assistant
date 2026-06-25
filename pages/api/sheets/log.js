import {
  getSheetsClient,
  getSheetId,
  ensureMeetingLogTab,
  TAB_MEETING_LOG,
} from '../../../lib/googleSheets'

const VALID_COMPANIES = ['codeupscale', 'ridgetheory']

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ success: false, error: 'Method not allowed' })
  }

  try {
    const {
      company,
      meetingId,
      meetingType,
      clientName,
      clientCompany,
      meetingGoal,
      duration,
      topics,
      actionItems,
      outcome,
      summary,
    } = req.body

    if (!company || !VALID_COMPANIES.includes(company)) {
      return res.status(200).json({ success: false, error: 'Invalid company' })
    }

    const sheetId = getSheetId(company)
    if (!sheetId) {
      return res.status(200).json({ success: false, error: 'Sheet ID not configured' })
    }

    const sheets = getSheetsClient()
    await ensureMeetingLogTab(sheets, sheetId)

    const now = new Date()
    const date = now.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const time = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${TAB_MEETING_LOG}!A:L`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          meetingId,
          date,
          time,
          meetingType,
          clientName,
          clientCompany,
          meetingGoal,
          duration,
          topics,
          actionItems,
          outcome,
          summary,
        ]],
      },
    })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Sheets log error:', err)
    return res.status(200).json({ success: false, error: err.message })
  }
}
