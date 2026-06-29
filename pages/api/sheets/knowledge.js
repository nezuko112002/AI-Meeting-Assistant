import {
  getSheetsClient,
  getSheetId,
  TAB_ALL_WORK,
} from '../../../lib/googleSheets'

const VALID_COMPANIES = ['codeupscale', 'ridgetheory']

function columnIndex(headerRow, name) {
  const idx = headerRow.indexOf(name)
  return idx >= 0 ? idx : -1
}

function cell(row, idx) {
  return idx >= 0 ? (row[idx] || '') : ''
}

function mapKnowledgeRow(headerRow, row, company) {
  const cols = {
    companyName: columnIndex(headerRow, 'Company Name'),
    scopeOfServices: columnIndex(headerRow, 'Scope of Services'),
    projectName: columnIndex(headerRow, 'Project Name'),
    industry: columnIndex(headerRow, 'Industry'),
    techStack: columnIndex(headerRow, 'Tech Stack'),
    projectSummary: columnIndex(headerRow, 'Project Summary'),
    link: columnIndex(headerRow, 'Link'),
    owner: columnIndex(headerRow, 'Owner'),
    assignedTeam: columnIndex(headerRow, 'Assigned Team'),
    notes: columnIndex(headerRow, 'Notes'),
    signedContractLink: columnIndex(headerRow, 'Signed Contract Link'),
  }

  return {
    companyName: cell(row, cols.companyName),
    scopeOfServices: cell(row, cols.scopeOfServices),
    projectName: cell(row, cols.projectName),
    industry: cell(row, cols.industry),
    techStack: cell(row, cols.techStack),
    projectSummary: cell(row, cols.projectSummary),
    link: cell(row, cols.link),
    workedUnderPrime: cell(row, cols.owner),
    owner: cell(row, cols.assignedTeam),
    notes: cell(row, cols.notes),
    signedContractLink: cell(row, cols.signedContractLink),
    portfolioSource: company,
  }
}

async function loadKnowledgeForCompany(sheets, company) {
  const sheetId = getSheetId(company)
  if (!sheetId) return []

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_ALL_WORK}!A:Z`,
  })

  const rows = response.data.values || []
  if (rows.length < 2) return []

  const headerRow = rows[0]
  return rows
    .slice(1)
    .filter(row => row[0] && String(row[0]).trim())
    .map(row => mapKnowledgeRow(headerRow, row, company))
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ knowledge: [] })
  }

  try {
    const { company } = req.query
    const sheets = getSheetsClient()

    if (company === 'all') {
      const [codeupscale, ridgetheory] = await Promise.all([
        loadKnowledgeForCompany(sheets, 'codeupscale'),
        loadKnowledgeForCompany(sheets, 'ridgetheory'),
      ])
      const knowledge = [...codeupscale, ...ridgetheory]
      return res.status(200).json({ knowledge, total: knowledge.length })
    }

    if (!company || !VALID_COMPANIES.includes(company)) {
      return res.status(200).json({ knowledge: [] })
    }

    const knowledge = await loadKnowledgeForCompany(sheets, company)
    return res.status(200).json({ knowledge, total: knowledge.length })
  } catch (err) {
    console.error('Sheets knowledge error:', err)
    return res.status(200).json({ knowledge: [], error: err.message })
  }
}
