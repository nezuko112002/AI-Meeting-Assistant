import { google } from 'googleapis'

export const TAB_ALL_WORK = 'All Work'
export const TAB_MEETING_LOG = 'Meeting Log'

export const SHEET_IDS = {
  codeupscale: process.env.GOOGLE_SHEET_CODEUPSCALE_ID,
  ridgetheory: process.env.GOOGLE_SHEET_RIDGETHEORY_ID,
}

export function normalizePrivateKey(key) {
  if (!key) return ''
  let normalized = key.trim()
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1)
  }
  normalized = normalized.replace(/\\n/g, '\n').replace(/\r/g, '')
  if (normalized.endsWith(',')) {
    normalized = normalized.slice(0, -1).trim()
  }
  return normalized
}

export function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export function getSheetId(company) {
  return SHEET_IDS[company] || null
}

export async function tabExists(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  return meta.data.sheets.some(
    s => s.properties.title === tabName
  )
}

export async function getTabSheetId(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const sheet = meta.data.sheets.find(s => s.properties.title === tabName)
  return sheet?.properties?.sheetId ?? null
}

/** Force Date (B) and Time (C) columns to plain text so both spreadsheets display the same way. */
export async function ensureMeetingLogDateTimeTextFormat(sheets, spreadsheetId) {
  const sheetId = await getTabSheetId(sheets, spreadsheetId, TAB_MEETING_LOG)
  if (sheetId == null) return

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: 1,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'TEXT' },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      }],
    },
  })
}

export function formatMeetingLogDateTime(now = new Date()) {
  const date = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return { date, time }
}

export async function ensureMeetingLogTab(sheets, spreadsheetId) {
  const exists = await tabExists(sheets, spreadsheetId, TAB_MEETING_LOG)
  if (exists) return

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: { title: TAB_MEETING_LOG },
        },
      }],
    },
  })

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_MEETING_LOG}!A1:L1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Meeting ID',
        'Date',
        'Time',
        'Meeting Type',
        'Client Name',
        'Client Company',
        'Meeting Goal',
        'Duration',
        'Key Topics',
        'Action Items',
        'Outcome',
        'Full Summary',
      ]],
    },
  })

  await ensureMeetingLogDateTimeTextFormat(sheets, spreadsheetId)
}
