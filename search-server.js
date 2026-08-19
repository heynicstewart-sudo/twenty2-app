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
          'LinkedIn URL': linkedinUrl || '',
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

// ===================== INTELLIGENCE =====================
// Pulls the full contact + touch point picture from Airtable, hands it to
// Claude, and asks for four sections of outreach intelligence back as JSON.

app.post('/api/intelligence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const [contactsData, touchPointsData] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points')
    ]);

    const contacts = (contactsData.records || []).map(r => ({
      name: r.fields['Full Name'] || '',
      company: r.fields['Company'] || '',
      role: r.fields['Job Title'] || '',
      icpRoleCategory: r.fields['ICP Role Category'] || '',
      journeyStage: r.fields['Journey Stage'] || '',
      linkedinUrl: r.fields['LinkedIn URL'] || '',
      notes: r.fields['Notes'] || ''
    }));

    const touchPoints = (touchPointsData.records || []).map(r => ({
      contact: (r.fields['Contact'] || [])[0] || null,
      date: r.fields['Date'] || '',
      type: r.fields['Type'] || '',
      outcome: r.fields['Outcome'] || '',
      direction: r.fields['Direction'] || '',
      notes: r.fields['Notes'] || ''
    }));

    const prompt = `You are the outreach intelligence layer for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy.

Here is the full current dataset synced from Airtable.

CONTACTS (${contacts.length}):
${JSON.stringify(contacts, null, 2)}

TOUCH POINTS (${touchPoints.length}):
${JSON.stringify(touchPoints, null, 2)}

Analyse this data and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "campaignSuggestions": string[],
  "coldContacts": string[],
  "relationshipHealth": string[],
  "messageDrafts": [{ "contactName": string, "draft": string }]
}

Guidance for each section:
- campaignSuggestions: 3-5 concrete outreach campaign or angle ideas based on real patterns in the data (shared roles, industries, company clusters, recurring themes in notes).
- coldContacts: contacts with no recent touch points or who have gone quiet after early engagement, each as one sentence naming the contact and why they're worth a nudge.
- relationshipHealth: a short read on which relationships are warm and which are at risk, each as one sentence naming the contact and the reasoning.
- messageDrafts: 2-4 ready-to-send message drafts for specific contacts who look due for a follow-up. UK English, no em dashes, peer to peer tone, one observation and one question, 3-4 sentences, signed off "Marcus".

If there isn't enough data for a section, return an empty array for it rather than inventing contacts that aren't in the dataset.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Claude API error ${aiRes.status}: ${errText}`);
    }

    const aiData = await aiRes.json();
    const block = (aiData.content || []).find(b => b.type === 'text');
    if (!block) throw new Error('No text content in Claude response');

    let parsed;
    try {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : block.text);
    } catch (parseErr) {
      throw new Error('Could not parse Claude response as JSON');
    }

    res.json({
      campaignSuggestions: parsed.campaignSuggestions || [],
      coldContacts: parsed.coldContacts || [],
      relationshipHealth: parsed.relationshipHealth || [],
      messageDrafts: parsed.messageDrafts || [],
      contactCount: contacts.length,
      touchPointCount: touchPoints.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Intelligence error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
