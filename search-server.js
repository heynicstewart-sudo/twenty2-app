// v2
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SERPER_URL = 'https://google.serper.dev/search';

function extractName(title){
  if(!title) return '';
  return title.split(' - ')[0].split(' | ')[0].trim();
}

const INVALID_NAME_PATTERN = /linkedin|sign in|log in|search results?|profiles?|jobs?|^\d+\+?\s*(connections|followers)/i;

function isValidName(name){
  if(!name) return false;
  const n = name.trim();
  if(n.length < 3 || n.length > 60) return false;
  if(INVALID_NAME_PATTERN.test(n)) return false;
  if(!n.includes(' ')) return false;
  return /^[A-Za-z][A-Za-z.'\- ]+$/.test(n);
}

function isConfidentMatch(result, companyWords, titleWords){
  if(!result.link || !/linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/i.test(result.link.split('?')[0])) return false;
  const haystack = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
  const hasTitle = titleWords.every(w => haystack.includes(w));
  const meaningfulCompanyWords = companyWords.filter(w => w.length > 2);
  const hasCompany = meaningfulCompanyWords.length
    ? meaningfulCompanyWords.every(w => haystack.includes(w))
    : companyWords.some(w => haystack.includes(w));
  return hasTitle && hasCompany && isValidName(extractName(result.title));
}

app.get('/api/search-contact', async (req, res) => {
  const company = (req.query.company || '').trim();
  const jobTitle = (req.query.jobTitle || '').trim();

  if(!company || !jobTitle){
    return res.status(400).json({ found: false, error: 'company and jobTitle query params are required' });
  }
  if(!process.env.SERPER_API_KEY){
    return res.status(500).json({ found: false, error: 'SERPER_API_KEY is not configured' });
  }

  const query = `${company} ${jobTitle} linkedin`;

  try {
    const serperRes = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query })
    });

    if(!serperRes.ok){
      throw new Error(`Serper API error: ${serperRes.status}`);
    }

    const data = await serperRes.json();
    const results = data.organic || [];

    const companyWords = company.toLowerCase().split(/\s+/).filter(Boolean);
    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter(Boolean);

    const match = results.find(r => isConfidentMatch(r, companyWords, titleWords));

    if(!match){
      return res.json({ found: false });
    }

    return res.json({
      name: extractName(match.title),
      url: match.link,
      found: true
    });
  } catch(err){
    console.error('Search error for', company, jobTitle, '-', err.message);
    return res.status(500).json({ found: false, error: 'search_failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 't2c-outreach-crm.html'));
});

// ===================== AIRTABLE CONFIG =====================
const AIRTABLE_BASE_ID = 'appKe5oopNpheq32n';
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableRequest(method, table, body) {
  const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}`, {
    method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable error ${res.status}: ${err}`);
  }
  return res.json();
}

// ===================== MIDDLEWARE =====================
app.use(express.json());

// ===================== AIRTABLE ROUTES =====================

// Create or update a contact in Airtable
app.post('/api/airtable/contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { name, company, role, linkedinUrl, state: contactState, icpRoleCategory, notes } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company are required' });

  try {
    const data = await airtableRequest('POST', 'Contacts', {
      records: [{
        fields: {
          'Full Name': name,
          'Job Title': role || '',
          'Company': company,
          'LinkedIn URL': linkedinUrl || '',
          'ICP Role Category': icpRoleCategory || role || '',
          'Journey Stage': mapStateToStage(contactState),
          'Notes': notes || ''
        }
      }]
    });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable contact create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a touch point in Airtable
app.post('/api/airtable/touchpoint', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, company, date, type, notes, outcome } = req.body;
  if (!contactName || !type) return res.status(400).json({ error: 'contactName and type are required' });

  try {
    // First find the contact record in Airtable
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${contactName}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const contactRecord = searchData.records && searchData.records[0];

    const fields = {
      'Date': date || new Date().toISOString().slice(0, 10),
      'Type': type,
      'Notes': notes || '',
      'Outcome': outcome || 'No reply',
      'Direction': 'Outbound'
    };

    // Link to contact record if found
    if (contactRecord) {
      fields['Contact'] = [contactRecord.id];
    }

    const data = await airtableRequest('POST', 'Touch Points', { records: [{ fields }] });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable touch point error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a contact's journey stage
app.patch('/api/airtable/contact/stage', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, company, state: contactState } = req.body;
  if (!contactName) return res.status(400).json({ error: 'contactName is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${contactName}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];
    if (!record) return res.json({ success: false, message: 'Contact not found in Airtable' });

    await airtableRequest('PATCH', 'Contacts', {
      records: [{
        id: record.id,
        fields: { 'Journey Stage': mapStateToStage(contactState) }
      }]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Airtable stage update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Map app state to Airtable Journey Stage values
function mapStateToStage(state) {
  const map = {
    'found': 'Identified',
    'opened': 'Identified',
    'connected': 'Connected',
    'messaging': 'Messaging',
    'booked': 'Booked'
  };
  return map[state] || 'Identified';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
