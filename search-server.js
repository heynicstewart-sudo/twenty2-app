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

// Fetch all contacts from Airtable
app.get('/api/airtable/contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const data = await airtableRequest('GET', 'Contacts');
    res.json(data.records || []);
  } catch (err) {
    console.error('Airtable contact list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create or update a contact in Airtable
app.post('/api/airtable/contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { name, company, role, linkedinUrl, state: contactState, icpRoleCategory, notes, companyLinkedinUrl } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company are required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${name}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records && searchData.records[0];
    if (existing) {
      return res.json({ success: true, skipped: true, recordId: existing.id });
    }

    const fields = {
      'Full Name': name,
      'Job Title': role || '',
      'LinkedIn URL': linkedinUrl || '',
      'Journey Stage': mapStateToStage(contactState),
      'Notes': notes || ''
    };
    if (companyLinkedinUrl) fields['Company LinkedIn URL'] = companyLinkedinUrl;

    const data = await airtableRequest('POST', 'Contacts', {
      records: [{ fields }]
    });
    res.json({ success: true, skipped: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable contact create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a company in Airtable, skipping if one with that name already exists
app.post('/api/airtable/company', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${name}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records && searchData.records[0];
    if (existing) {
      return res.json({ success: true, skipped: true, recordId: existing.id });
    }

    const data = await airtableRequest('POST', 'Companies', {
      records: [{ fields: { 'Company Name': name } }]
    });
    res.json({ success: true, skipped: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable company create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a touch point in Airtable
app.post('/api/airtable/touchpoint', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, company, date, type, notes, outcome, communicationMethod, aiBrief } = req.body;
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
    if (communicationMethod) fields['Communication Method'] = communicationMethod;
    if (aiBrief) fields['AI Brief'] = aiBrief;

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

  const { contactName, company, state: contactState, nextTouchDate, painPoints } = req.body;
  if (!contactName) return res.status(400).json({ error: 'contactName is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${contactName}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];
    if (!record) return res.json({ success: false, message: 'Contact not found in Airtable' });

    const fields = {};
    if (contactState) fields['Journey Stage'] = mapStateToStage(contactState);
    if (nextTouchDate) fields['Next Touch Date'] = nextTouchDate;
    if (painPoints && painPoints.length) fields['Pain Points'] = painPoints;

    await airtableRequest('PATCH', 'Contacts', {
      records: [{
        id: record.id,
        fields
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

// ===================== COMPANY LINKEDIN =====================
// Finds a company's LinkedIn company page via Serper and writes it onto the
// Airtable Companies table (primary field "Company Name").

app.get('/api/search-company-linkedin', async (req, res) => {
  const company = (req.query.company || '').trim();
  if (!company) return res.status(400).json({ found: false, error: 'company query param is required' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ found: false, error: 'SERPER_API_KEY is not configured' });

  const query = `${company} site:linkedin.com/company/`;

  try {
    const serperRes = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    if (!serperRes.ok) throw new Error(`Serper API error: ${serperRes.status}`);

    const data = await serperRes.json();
    const results = data.organic || [];
    const match = results.find(r => r.link && /linkedin\.com\/company\/[^/?#]+/i.test(r.link));
    if (!match) return res.json({ found: false });

    const slugMatch = match.link.match(/linkedin\.com\/company\/([^/?#]+)/i);
    const slug = slugMatch ? slugMatch[1] : null;
    if (!slug) return res.json({ found: false });

    const linkedinUrl = `https://linkedin.com/company/${slug}`;

    // Best-effort write to the Airtable Companies table - doesn't block the response.
    if (AIRTABLE_API_KEY) {
      try {
        const searchRes = await fetch(
          `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${company}"`)}`,
          { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
        );
        const searchData = await searchRes.json();
        const record = searchData.records && searchData.records[0];
        if (record) {
          await airtableRequest('PATCH', 'Companies', {
            records: [{ id: record.id, fields: { 'Company LinkedIn URL': linkedinUrl } }]
          });
        } else {
          await airtableRequest('POST', 'Companies', {
            records: [{ fields: { 'Company Name': company, 'Company LinkedIn URL': linkedinUrl } }]
          });
        }
      } catch (airtableErr) {
        console.warn('Could not write company LinkedIn URL to Airtable:', airtableErr.message);
      }
    }

    return res.json({ found: true, linkedinUrl, slug });
  } catch (err) {
    console.error('Company LinkedIn search error for', company, '-', err.message);
    return res.status(500).json({ found: false, error: 'search_failed' });
  }
});

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

// ===================== ENRICHMENT =====================
// Looks up a contact's current LinkedIn bio/title plus any recent public
// mentions via two Serper searches, then asks Claude to synthesise a
// research profile. Stored back onto the Airtable Contact record.

function extractLinkedInSlug(url) {
  const match = (url || '').match(/\/in\/([^/?#]+)/i);
  return match ? match[1] : null;
}

app.post('/api/enrich/contact', async (req, res) => {
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { linkedinUrl, name, company } = req.body;
  if (!linkedinUrl || !name) return res.status(400).json({ error: 'linkedinUrl and name are required' });

  const slug = extractLinkedInSlug(linkedinUrl);
  if (!slug) return res.status(400).json({ error: 'Could not parse a LinkedIn slug from that URL' });

  try {
    const [profileSearch, newsSearch] = await Promise.all([
      fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `site:linkedin.com/in/${slug}` })
      }).then(r => r.json()),
      fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `${name} ${company || ''}`.trim() })
      }).then(r => r.json())
    ]);

    const profileResults = (profileSearch.organic || []).slice(0, 5)
      .map(r => `${r.title || ''}\n${r.snippet || ''}`).join('\n\n');
    const newsResults = (newsSearch.organic || []).slice(0, 5)
      .map(r => `${r.title || ''}\n${r.snippet || ''}\n${r.link || ''}`).join('\n\n');

    const prompt = `You are researching a LinkedIn contact for a Perth-based Agile and change consultancy (Twenty2 Collective) ahead of outreach.

Contact: ${name}${company ? ' at ' + company : ''}.
LinkedIn: ${linkedinUrl}

Search results for their LinkedIn profile (site:linkedin.com/in/${slug}):
${profileResults || 'No results found.'}

Search results for "${name} ${company || ''}" (news, interviews, speaking events):
${newsResults || 'No results found.'}

Based only on the above, return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "currentTitle": string,
  "company": string,
  "bio": string,
  "recentActivity": string,
  "likelyPainPoints": string,
  "bestOutreachAngle": string
}

If the search results do not give enough to fill a field confidently, say so plainly in that field (e.g. "Not enough public information found") rather than inventing detail.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
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

    let profile;
    try {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      profile = JSON.parse(jsonMatch ? jsonMatch[0] : block.text);
    } catch (parseErr) {
      throw new Error('Could not parse Claude response as JSON');
    }

    const formattedText = [
      `Current title: ${profile.currentTitle || '—'}`,
      `Company: ${profile.company || '—'}`,
      `Bio: ${profile.bio || '—'}`,
      `Recent activity: ${profile.recentActivity || '—'}`,
      `Likely pain points: ${profile.likelyPainPoints || '—'}`,
      `Best outreach angle: ${profile.bestOutreachAngle || '—'}`
    ].join('\n\n');

    // Store back onto the Airtable Contact record. Non-fatal if this fails -
    // the enrichment itself already succeeded and should still reach the client.
    try {
      const searchRes = await fetch(
        `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${name}"`)}`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
      );
      const searchData = await searchRes.json();
      const record = searchData.records && searchData.records[0];
      if (record) {
        await airtableRequest('PATCH', 'Contacts', {
          records: [{ id: record.id, fields: { 'Enrichment Profile': formattedText } }]
        });
      }
    } catch (airtableErr) {
      console.warn('Could not store enrichment profile to Airtable:', airtableErr.message);
    }

    res.json({ success: true, profile, formattedText });
  } catch (err) {
    console.error('Enrichment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
