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

// Fetch a single Airtable record by its record id (not a search-by-field lookup)
async function airtableGetRecord(table, recordId) {
  const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}/${recordId}`, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
  });
  if (!res.ok) return null;
  return res.json();
}

// Shared "find one record where {fieldName}=value" lookup - used throughout
// this file already as an inlined fetch per-route; new code in this task
// uses this shared version instead of repeating it again.
async function findRecordByFieldName(table, fieldName, value) {
  if (!value) return null;
  const res = await fetch(
    `${AIRTABLE_URL}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(`{${fieldName}}="${value}"`)}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  const data = await res.json();
  return (data.records && data.records[0]) || null;
}

// Shared Claude call - `content` is either a plain string (text-only) or an
// array of content blocks (for vision/PDF document prompts). Every new
// Claude-calling route added in the Context tab work uses this instead of
// re-inlining the fetch/parse boilerplate that the older routes each have.
async function callClaudeMessages(content, maxTokens) {
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }]
    })
  });
  if (!aiRes.ok) {
    const errText = await aiRes.text();
    throw new Error(`Claude API error ${aiRes.status}: ${errText}`);
  }
  const aiData = await aiRes.json();
  const block = (aiData.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('No text content in Claude response');
  return block.text;
}

async function callClaudeText(content, maxTokens) {
  return (await callClaudeMessages(content, maxTokens)).trim();
}

async function callClaudeJson(content, maxTokens) {
  const text = await callClaudeMessages(content, maxTokens);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (parseErr) {
    throw new Error('Could not parse Claude response as JSON');
  }
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

  // Note: "gridName" was previously written to a "Grid Name" field that
  // does not exist on the real Contacts table - removed rather than added,
  // per instruction not to create missing fields. Grid membership is still
  // tracked locally in the app's own state; it just isn't mirrored to
  // Airtable right now.
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

    const companySearchRes = await fetch(
      `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${company}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const companySearchData = await companySearchRes.json();
    const companyRecord = companySearchData.records && companySearchData.records[0];
    if (companyRecord) fields['Company'] = [companyRecord.id];

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

  // "gridName" no longer written - see the matching note in
  // POST /api/airtable/contact above.
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

// Update a company's LinkedIn URL and slug in Airtable
app.patch('/api/airtable/company/linkedin', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { companyName, linkedinUrl, linkedinSlug } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${companyName}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];
    if (!record) return res.json({ success: false, message: 'Company not found in Airtable' });

    const fields = {};
    if (linkedinUrl) fields['Company LinkedIn URL'] = linkedinUrl;
    if (linkedinSlug) fields['LinkedIn Company ID'] = linkedinSlug;

    await airtableRequest('PATCH', 'Companies', {
      records: [{ id: record.id, fields }]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Airtable company LinkedIn update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a campaign in Airtable, skipping if one with that name already exists
// Campaigns are wholly authored by this app (unlike Contacts/Companies,
// which are protected from being overwritten by design) - so this is an
// upsert by Name: update the existing record if found, else create one.
// This changed from the previous create-only-skip behaviour because the
// campaign detail view now edits strategy/sequence/contacts after creation
// and those edits need to actually reach Airtable.
app.post('/api/airtable/campaign', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  // pitchAngle/objectionHandling have no matching fields on the real
  // Campaigns table (no "Pitch Angle"/"Objection Handling" columns exist),
  // so they're folded into the existing "Strategy Notes" field as
  // labelled sections rather than dropped - that field already exists and
  // is semantically the right home for them.
  const { name, goal, product, targetIcp, contactIds, sequenceTemplates, strategyNotes, pitchAngle, objectionHandling, successMetric, startDate, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Campaigns?filterByFormula=${encodeURIComponent(`{Name}="${name}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records && searchData.records[0];

    const strategyNotesParts = [strategyNotes || ''];
    if (pitchAngle) strategyNotesParts.push(`Pitch angle: ${pitchAngle}`);
    if (objectionHandling) strategyNotesParts.push(`Objection handling: ${objectionHandling}`);

    const fields = {
      'Name': name,
      'Goal': goal || '',
      'Product': product || '',
      'Target ICP': targetIcp || '',
      'Contact IDs': (contactIds || []).join(', '),
      'Sequence Templates': sequenceTemplates || '',
      'Strategy Notes': strategyNotesParts.filter(Boolean).join('\n\n'),
      'Success Metric': successMetric || '',
      'Start Date': startDate || '',
      'Status': status || 'Draft'
    };

    if (existing) {
      await airtableRequest('PATCH', 'Campaigns', { records: [{ id: existing.id, fields }] });
      return res.json({ success: true, updated: true, recordId: existing.id });
    }

    const data = await airtableRequest('POST', 'Campaigns', { records: [{ fields }] });
    res.json({ success: true, updated: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable campaign upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a campaign's status in Airtable
app.patch('/api/campaign/status', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { name, status } = req.body;
  if (!name || !status) return res.status(400).json({ error: 'name and status are required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Campaigns?filterByFormula=${encodeURIComponent(`{Name}="${name}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];
    if (!record) return res.json({ success: false, message: 'Campaign not found in Airtable' });

    await airtableRequest('PATCH', 'Campaigns', {
      records: [{ id: record.id, fields: { 'Status': status } }]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Campaign status update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a touch point in Airtable
// contactName/company (single, by name) are the original call shape used
// throughout the rest of the app. contactRecordIds/companyRecordId (direct
// Airtable ids, possibly multiple contacts) are used by the Context tab,
// which already has ids from GET /api/context/data and shouldn't have to
// round-trip a name search it doesn't need. Company is a new linked field
// on Touch Points - previously "company" was accepted but never written
// anywhere; every existing caller that already sends a company name now
// gets it properly linked as a bonus, not a behaviour change for them.
// The real Touch Points table has no "Company" linked field at all (only
// "Contact"), no "Replied" checkbox, its long-text notes field is named
// "Summary" not "Notes", and its AI-brief-style field is named "Outreach
// Brief" not "AI Brief". Company association still works fine via Contact
// -> Contact's own Company link wherever this app needs it; "replied" is
// derived from Outcome === "Replied" everywhere it's read, which is what
// this field was always set from anyway, so nothing is lost by not storing
// it a second time as a separate boolean.
// campaignId/campaignName (optional) come from the Campaign > Intelligence
// tab, which reuses this exact endpoint so saves there work identically to
// the top-level Context tab - just tagged with the campaign too. The real
// Touch Points table has no confirmed "Campaign" field, so the tag is
// written into Summary (guaranteed to work) and a best-effort "Campaign"
// field write is also attempted, swallowed silently if that field doesn't
// exist, so it never breaks the primary save either way.
app.post('/api/airtable/touchpoint', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, contactNames, contactRecordIds, date, type, notes, outcome, communicationMethod, aiBrief, campaignId, campaignName } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });

  try {
    let contactIds = [];
    if (Array.isArray(contactRecordIds) && contactRecordIds.length) {
      contactIds = contactRecordIds;
    } else {
      const names = (Array.isArray(contactNames) && contactNames.length) ? contactNames : (contactName ? [contactName] : []);
      if (!names.length) return res.status(400).json({ error: 'contactName(s) or contactRecordIds are required' });
      const records = await Promise.all(names.map(n => findRecordByFieldName('Contacts', 'Full Name', n)));
      contactIds = records.filter(Boolean).map(r => r.id);
    }

    const summary = campaignName ? `[Campaign: ${campaignName}] ${notes || ''}`.trim() : (notes || '');
    const fields = {
      'Date': date || new Date().toISOString().slice(0, 10),
      'Type': type,
      'Summary': summary,
      'Outcome': outcome || 'No reply',
      'Direction': 'Outbound'
    };
    if (communicationMethod) fields['Communication Method'] = communicationMethod;
    if (aiBrief) fields['Outreach Brief'] = aiBrief;
    if (contactIds.length) fields['Contact'] = contactIds;

    const data = await airtableRequest('POST', 'Touch Points', { records: [{ fields }] });
    const recordId = data.records[0].id;

    if (campaignName) {
      try {
        await airtableRequest('PATCH', 'Touch Points', { records: [{ id: recordId, fields: { 'Campaign': campaignName } }] });
      } catch (tagErr) {
        console.warn('Best-effort Campaign field write on Touch Points failed (field may not exist):', tagErr.message);
      }
    }

    res.json({ success: true, recordId });
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
            records: [{ id: record.id, fields: { 'Company LinkedIn URL': linkedinUrl, 'LinkedIn Company ID': slug } }]
          });
        } else {
          await airtableRequest('POST', 'Companies', {
            records: [{ fields: { 'Company Name': company, 'Company LinkedIn URL': linkedinUrl, 'LinkedIn Company ID': slug } }]
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

// Fetches a LinkedIn company page's HTML via Serper's scrape endpoint and
// extracts the numeric org ID embedded in it (urn:li:fsd_company:XXXXX).
app.get('/api/enrich/linkedin-org-id', async (req, res) => {
  const slug = (req.query.slug || '').trim();
  if (!slug) return res.status(400).json({ found: false, error: 'slug query param is required' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ found: false, error: 'SERPER_API_KEY is not configured' });

  const pageUrl = `https://www.linkedin.com/company/${slug}/`;

  try {
    const scrapeRes = await fetch('https://scrape.serper.dev', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl })
    });
    if (!scrapeRes.ok) throw new Error(`Serper scrape error: ${scrapeRes.status}`);

    const data = await scrapeRes.json();
    // Response field names aren't fully confirmed - check every plausible
    // place the raw/rendered page content could live.
    const haystack = [data.text, data.html, data.markdown, JSON.stringify(data)]
      .filter(Boolean).join('\n');

    const match = haystack.match(/urn:li:fsd_company:(\d+)/);
    if (!match) return res.json({ found: false });

    return res.json({ found: true, orgId: `urn:li:organization:${match[1]}` });
  } catch (err) {
    console.error('LinkedIn org ID lookup error for', slug, '-', err.message);
    return res.status(500).json({ found: false, error: 'lookup_failed' });
  }
});

// ===================== LEARNING DATA =====================
// Historical customer/deal CSVs get mined by Claude for ICP and sales
// patterns, and the resulting analysis is stored in the Airtable Learning
// Data table (fields: Type, Analysis, Record Count, Created Date - the
// date field is actually named "Created Date" on the real table, not
// "Date").  Every future analysis, including /api/intelligence, pulls this
// table back in as context so it compounds with each upload instead of
// starting fresh.

async function fetchLearningData() {
  try {
    const data = await airtableRequest('GET', 'Learning Data');
    return (data.records || []).map(r => ({
      type: r.fields['Type'] || '',
      analysis: r.fields['Analysis'] || '',
      recordCount: r.fields['Record Count'] || 0,
      date: r.fields['Created Date'] || ''
    }));
  } catch (err) {
    console.warn('Could not fetch Learning Data (table may not exist yet):', err.message);
    return [];
  }
}

async function storeLearningData(type, analysis, recordCount) {
  await airtableRequest('POST', 'Learning Data', {
    records: [{
      fields: {
        'Type': type,
        'Analysis': JSON.stringify(analysis),
        'Record Count': recordCount,
        'Created Date': new Date().toISOString().slice(0, 10)
      }
    }]
  });
}

function learningDataContext(learningData) {
  if (!learningData.length) return 'No prior learning data on file yet.';
  return learningData.map(l => `- [${l.type}, ${l.date}, ${l.recordCount} records]: ${l.analysis}`).join('\n');
}

// ===================== CONVERSION TRACKING =====================
// Every "Meeting Booked" touch point outcome writes a Conversion record
// here from the client. The Conversions table (field names given exactly
// by spec: Contact Name, Company, ICP Role, Industry, Campaign, Product,
// Touch Point Count, Days to Convert, Communication Method, Date) is the
// ground truth the intelligence engine and the "What's working" panel both
// learn from.

app.post('/api/track/conversion', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, company, icpRole, industry, campaign, product, touchPointCount, daysToConvert, communicationMethod } = req.body;
  if (!contactName) return res.status(400).json({ error: 'contactName is required' });

  try {
    const data = await airtableRequest('POST', 'Conversions', {
      records: [{
        fields: {
          'Contact Name': contactName,
          'Company': company || '',
          'ICP Role': icpRole || '',
          'Industry': industry || '',
          'Campaign': campaign || '',
          'Product': product || '',
          'Touch Point Count': touchPointCount || 0,
          'Days to Convert': daysToConvert || 0,
          'Communication Method': communicationMethod || '',
          'Date': new Date().toISOString().slice(0, 10)
        }
      }]
    });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Conversion tracking error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function fetchConversions() {
  try {
    const data = await airtableRequest('GET', 'Conversions');
    return (data.records || []).map(r => ({
      contactName: r.fields['Contact Name'] || '',
      company: r.fields['Company'] || '',
      icpRole: r.fields['ICP Role'] || '',
      industry: r.fields['Industry'] || '',
      campaign: r.fields['Campaign'] || '',
      product: r.fields['Product'] || '',
      touchPointCount: r.fields['Touch Point Count'] || 0,
      daysToConvert: r.fields['Days to Convert'] || 0,
      communicationMethod: r.fields['Communication Method'] || '',
      date: r.fields['Date'] || ''
    }));
  } catch (err) {
    console.warn('Could not fetch Conversions (table may not exist yet):', err.message);
    return [];
  }
}

function rankCounts(items, keyFn) {
  const counts = {};
  items.forEach(item => {
    const key = keyFn(item);
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function conversionsContext(conversions) {
  if (!conversions.length) return 'No conversions logged yet.';
  return conversions.map(c => `- ${c.contactName} (${c.icpRole || 'role unknown'} at ${c.company || 'unknown company'}, ${c.industry || 'unknown industry'}) converted via ${c.communicationMethod || 'unknown method'} on campaign "${c.campaign || 'none'}" for product "${c.product || 'unknown'}" after ${c.touchPointCount || 0} touch points and ${c.daysToConvert || 0} days.`).join('\n');
}

// "What's working" - ranked, real numbers from the Conversions table. Shared
// between GET /api/track/insights (its own refresh button) and POST
// /api/intelligence (folded into the one big dashboard payload).
function computeWhatsWorking(conversions) {
  const topIcpRoles = rankCounts(conversions, c => c.icpRole)
    .slice(0, 5)
    .map(([role, count]) => `${role} — ${count} conversion${count === 1 ? '' : 's'}`);

  const topProducts = rankCounts(conversions, c => c.product)
    .slice(0, 5)
    .map(([product, count]) => `${product} — ${count} conversion${count === 1 ? '' : 's'}`);

  const topMethods = rankCounts(conversions, c => c.communicationMethod)
    .slice(0, 5)
    .map(([method, count]) => `${method} — ${count} conversion${count === 1 ? '' : 's'}`);

  const topIndustries = rankCounts(conversions, c => c.industry)
    .slice(0, 5)
    .map(([industry, count]) => `${industry} — ${count} conversion${count === 1 ? '' : 's'}`);

  const touchCounts = conversions.map(c => c.touchPointCount).filter(n => typeof n === 'number' && n > 0);
  const avgTouchPoints = touchCounts.length
    ? Math.round((touchCounts.reduce((s, n) => s + n, 0) / touchCounts.length) * 10) / 10
    : null;

  return { topIcpRoles, topProducts, topMethods, topIndustries, avgTouchPoints, conversionCount: conversions.length };
}

app.get('/api/track/insights', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const conversions = await fetchConversions();
    res.json(computeWhatsWorking(conversions));
  } catch (err) {
    console.error('Track insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== ENGINE HEALTH =====================
// Raw database stats - no Claude involved, just counts. Shared between
// GET /api/intelligence/health (its own refresh button) and POST
// /api/intelligence (folded into the one big dashboard payload).

async function fetchCampaigns() {
  try {
    const data = await airtableRequest('GET', 'Campaigns');
    return (data.records || []).map(r => ({
      name: r.fields['Name'] || '',
      status: r.fields['Status'] || '',
      product: r.fields['Product'] || '',
      contactNamesRaw: r.fields['Contact IDs'] || '',
      startDate: r.fields['Start Date'] || ''
    }));
  } catch (err) {
    console.warn('Could not fetch Campaigns:', err.message);
    return [];
  }
}

function computeEngineHealth(contacts, touchPoints, campaigns) {
  const totalContacts = contacts.length;

  const stageCounts = {};
  contacts.forEach(c => {
    const stage = c.journeyStage || 'Unknown';
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
  });
  const contactsByStage = Object.entries(stageCounts).map(([stage, count]) => ({ stage, count }));

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const touchPointsThisWeek = touchPoints.filter(tp => tp.date && new Date(tp.date) >= oneWeekAgo).length;

  const activeCampaigns = campaigns.filter(c => c.status === 'Live').length;

  const bookedCount = contacts.filter(c => c.journeyStage === 'Booked').length;
  const overallConversionRate = totalContacts ? Math.round((bookedCount / totalContacts) * 100) : 0;

  return { totalContacts, contactsByStage, touchPointsThisWeek, activeCampaigns, overallConversionRate };
}

app.get('/api/intelligence/health', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const [contactsData, touchPointsData, campaigns] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchCampaigns()
    ]);

    const contacts = (contactsData.records || []).map(r => ({
      journeyStage: r.fields['Journey Stage'] || ''
    }));
    const touchPoints = (touchPointsData.records || []).map(r => ({
      date: r.fields['Date'] || ''
    }));

    res.json(computeEngineHealth(contacts, touchPoints, campaigns));
  } catch (err) {
    console.error('Intelligence health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CAMPAIGN PERFORMANCE =====================
// Ranks every Live campaign by real conversion rate, cross-referencing
// Campaigns (who was targeted), Touch Points (what was actually sent and
// who replied) and Conversions (what booked, matched by Campaign name).

function computeCampaignPerformance(campaigns, contacts, touchPoints, conversions) {
  const nameToId = {};
  contacts.forEach(c => { if (c.name) nameToId[c.name] = c.id; });

  return campaigns
    .filter(camp => camp.status === 'Live')
    .map(camp => {
      const targetNames = (camp.contactNamesRaw || '').split(',').map(s => s.trim()).filter(Boolean);
      const targetRecordIds = targetNames.map(n => nameToId[n]).filter(Boolean);

      const campaignTouchPoints = touchPoints.filter(tp =>
        tp.contact && targetRecordIds.includes(tp.contact) &&
        (!camp.startDate || !tp.date || tp.date >= camp.startDate)
      );
      const touchPointsSent = campaignTouchPoints.length;
      const replies = campaignTouchPoints.filter(tp => tp.outcome === 'Replied').length;
      const bookings = conversions.filter(cv => cv.campaign === camp.name).length;
      const contactsTargeted = targetNames.length;
      const conversionRate = contactsTargeted ? Math.round((bookings / contactsTargeted) * 100) : 0;

      return { campaignName: camp.name, contactsTargeted, touchPointsSent, replies, bookings, conversionRate };
    })
    .sort((a, b) => b.conversionRate - a.conversionRate || b.bookings - a.bookings);
}

// ===================== INTELLIGENCE =====================
// Pulls the full contact + touch point picture from Airtable, hands it to
// Claude, and asks for four sections of outreach intelligence back as JSON.

app.post('/api/intelligence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const [contactsData, touchPointsData, learningData, conversions, campaigns] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchLearningData(),
      fetchConversions(),
      fetchCampaigns()
    ]);
    // Note: there is no "Signals" table or concept anywhere in this app's
    // schema yet, so there is nothing to fetch for it - not fabricating one.

    const contacts = (contactsData.records || []).map(r => ({
      id: r.id,
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
      notes: r.fields['Summary'] || ''
    }));

    const whatsWorking = computeWhatsWorking(conversions);
    const engineHealth = computeEngineHealth(contacts, touchPoints, campaigns);
    const campaignPerformance = computeCampaignPerformance(campaigns, contacts, touchPoints, conversions);

    const prompt = `You are the outreach intelligence layer for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy.

Here is the full current dataset synced from Airtable.

CONTACTS (${contacts.length}):
${JSON.stringify(contacts, null, 2)}

TOUCH POINTS (${touchPoints.length}):
${JSON.stringify(touchPoints, null, 2)}

CAMPAIGNS (${campaigns.length}):
${JSON.stringify(campaigns, null, 2)}

LEARNING DATA from past customer and deal analysis (${learningData.length} analyses on file - use this to sharpen your suggestions, it reflects real historical ICP and sales patterns):
${learningDataContext(learningData)}

CONVERSIONS - actual meetings booked, logged with what led to them (${conversions.length} on file - this is ground truth for what's actually working, weight it heavily):
${conversionsContext(conversions)}

CAMPAIGN PERFORMANCE (already calculated, ranked best to worst by conversion rate):
${campaignPerformance.length ? campaignPerformance.map(c => `- ${c.campaignName}: ${c.contactsTargeted} contacts targeted, ${c.touchPointsSent} touch points sent, ${c.replies} replies, ${c.bookings} bookings, ${c.conversionRate}% conversion rate`).join('\n') : 'No live campaigns to report on.'}

ENGINE HEALTH (already calculated): ${engineHealth.totalContacts} total contacts, ${engineHealth.touchPointsThisWeek} touch points logged this week, ${engineHealth.activeCampaigns} active campaigns, ${engineHealth.overallConversionRate}% overall conversion rate. Contacts by journey stage: ${engineHealth.contactsByStage.map(s => `${s.stage}: ${s.count}`).join(', ') || 'none'}.

Analyse this data and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "campaignSuggestions": string[],
  "coldContacts": string[],
  "relationshipHealth": string[],
  "messageDrafts": [{ "contactName": string, "draft": string }],
  "learningInsights": string[],
  "optimisationSuggestions": string[]
}

Guidance for each section:
- campaignSuggestions: 3-5 concrete outreach campaign or angle ideas based on real patterns in the data (shared roles, industries, company clusters, recurring themes in notes) and, where relevant, the learning data and conversion patterns above (ICP profiles, products and communication methods that have actually converted).
- coldContacts: contacts with no recent touch points or who have gone quiet after early engagement, each as one sentence naming the contact and why they're worth a nudge.
- relationshipHealth: a short read on which relationships are warm and which are at risk, each as one sentence naming the contact and the reasoning.
- messageDrafts: 2-4 ready-to-send message drafts for specific contacts who look due for a follow-up. UK English, no em dashes, peer to peer tone, one observation and one question, 3-4 sentences, signed off "Marcus".
- learningInsights: 3-5 specific, numbers-backed observations pulled directly from the data above, in the style of "You haven't contacted 34 Transformation leads in 21+ days" or "Mining sector contacts convert after 3 touch points vs 6 for government". Every number must be real, counted from the data given, never estimated or invented.
- optimisationSuggestions: 3-5 specific, actionable improvements - which contacts to prioritise this week, which campaign needs attention (use the campaign performance data above), which ICP segment is underperforming, what message angle to try next. Each one grounded in something specific from the data, not generic sales advice.

If there isn't enough data for a section, return an empty array for it rather than inventing contacts, numbers or campaigns that aren't in the dataset.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2800,
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
      learningInsights: parsed.learningInsights || [],
      optimisationSuggestions: parsed.optimisationSuggestions || [],
      whatsWorking,
      engineHealth,
      campaignPerformance,
      contactCount: contacts.length,
      touchPointCount: touchPoints.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Intelligence error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyse a CSV of past customers for ICP and deal patterns
app.post('/api/learn/customers', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { records } = req.body;
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records is required and must be a non-empty array' });
  }

  try {
    const learningData = await fetchLearningData();

    const prompt = `You are the ICP analysis layer for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy.

Marcus has uploaded a CSV of past customers (won deals), parsed into rows:
${JSON.stringify(records, null, 2)}

Prior learning data already on file (build on this, don't just repeat it):
${learningDataContext(learningData)}

Analyse the past customer data and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "icpProfiles": string[],
  "dealCharacteristics": string[],
  "patterns": string[],
  "summary": string
}

Guidance:
- icpProfiles: the top performing ICP profiles - which roles and industries buy most - ranked by how strongly they show up in the data.
- dealCharacteristics: average deal characteristics across won customers (size, product mix, timeline, whatever the columns support).
- patterns: common patterns across won customers that predict success, drawn from the actual rows.
- summary: 2-3 sentences summarising what this data tells Marcus about who to target next.

Ground every point in the actual data provided. If a column is missing or a pattern isn't supported by the data, don't invent it.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
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

    const analysis = {
      icpProfiles: parsed.icpProfiles || [],
      dealCharacteristics: parsed.dealCharacteristics || [],
      patterns: parsed.patterns || [],
      summary: parsed.summary || ''
    };

    await storeLearningData('Customer Analysis', analysis, records.length);

    res.json(analysis);
  } catch (err) {
    console.error('Learn customers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyse a CSV of past contracts/deals for product-ICP fit and sales cycle patterns
app.post('/api/learn/deals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { records } = req.body;
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records is required and must be a non-empty array' });
  }

  try {
    const learningData = await fetchLearningData();

    const prompt = `You are the deal analysis layer for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy.

Marcus has uploaded a CSV of past contracts/deals, parsed into rows:
${JSON.stringify(records, null, 2)}

Prior learning data already on file (build on this, don't just repeat it):
${learningDataContext(learningData)}

Analyse the past deal data and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "productIcpMatches": string[],
  "touchPointsBeforeClose": string[],
  "bestIndustries": string[],
  "seasonalPatterns": string[],
  "summary": string
}

Guidance:
- productIcpMatches: which products/services sell to which ICPs, drawn from the actual rows.
- touchPointsBeforeClose: average number of touch points before close, broken down by product where the data supports it.
- bestIndustries: best performing industries by close rate or deal value.
- seasonalPatterns: any seasonal or timing patterns in when deals close.
- summary: 2-3 sentences summarising the key sales pattern Marcus should act on.

Ground every point in the actual data provided. If a column is missing or a pattern isn't supported by the data, don't invent it.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
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

    const analysis = {
      productIcpMatches: parsed.productIcpMatches || [],
      touchPointsBeforeClose: parsed.touchPointsBeforeClose || [],
      bestIndustries: parsed.bestIndustries || [],
      seasonalPatterns: parsed.seasonalPatterns || [],
      summary: parsed.summary || ''
    };

    await storeLearningData('Deal Analysis', analysis, records.length);

    res.json(analysis);
  } catch (err) {
    console.error('Learn deals error:', err.message);
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
        model: 'claude-haiku-4-5-20251001',
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

// ===================== CAMPAIGN CHAT + BUILD =====================
// Free-form campaign setup. /chat carries the conversation forward one turn
// at a time, grounded in real Airtable data, until Claude has enough to
// build the campaign. /build then does the heavier work of matching
// contacts and drafting the sequence from the full conversation.

async function fetchCampaignContext() {
  const [contactsData, touchPointsData] = await Promise.all([
    airtableRequest('GET', 'Contacts'),
    airtableRequest('GET', 'Touch Points')
  ]);

  const contacts = (contactsData.records || []).map(r => ({
    name: r.fields['Full Name'] || '',
    company: Array.isArray(r.fields['Company']) ? '' : (r.fields['Company'] || ''),
    role: r.fields['Job Title'] || '',
    journeyStage: r.fields['Journey Stage'] || '',
    notes: r.fields['Notes'] || ''
  })).filter(c => c.name);

  const touchPoints = (touchPointsData.records || []).map(r => ({
    type: r.fields['Type'] || '',
    outcome: r.fields['Outcome'] || '',
    painPoints: r.fields['Pain Points'] || []
  }));

  const bookedCount = contacts.filter(c => c.journeyStage === 'Booked').length;
  const conversionRate = contacts.length ? Math.round((bookedCount / contacts.length) * 100) : 0;

  return { contacts, touchPoints, bookedCount, conversionRate };
}

app.post('/api/campaign/chat', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { conversationHistory } = req.body;
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) {
    return res.status(400).json({ error: 'conversationHistory is required' });
  }

  try {
    const { contacts, touchPoints, conversionRate } = await fetchCampaignContext();

    const roles = [...new Set(contacts.map(c => c.role).filter(Boolean))];
    const companies = [...new Set(contacts.map(c => c.company).filter(Boolean))];
    const painPointCounts = {};
    touchPoints.forEach(tp => {
      const points = Array.isArray(tp.painPoints) ? tp.painPoints : [tp.painPoints];
      points.filter(Boolean).forEach(p => { painPointCounts[p] = (painPointCounts[p] || 0) + 1; });
    });

    const dataContext = `Real data available to ground this conversation (use it, don't invent beyond it):
- ${contacts.length} contacts total in Airtable.
- Roles present: ${roles.join(', ') || 'none recorded'}.
- Companies present: ${companies.join(', ') || 'none recorded'}.
- Pain points logged across touch points: ${Object.entries(painPointCounts).map(([p,n]) => `${p} (${n})`).join(', ') || 'none recorded'}.
- Overall historical conversion rate (booked / total contacts): ${conversionRate}%.`;

    const requiredFields = `A complete campaign needs: a clear goal, the product/service being promoted, a description of who to target, whether there's an existing strategy/script to build from (and what it is if so), a success metric (bookings, replies, or meetings), and a rough timeline.`;

    const conversationText = conversationHistory.map(m => `${m.role === 'assistant' ? 'You' : 'Marcus'}: ${m.content}`).join('\n');

    const prompt = `You are the campaign-setup assistant inside T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy. You're having a free-form conversation with Marcus to gather what's needed to build an outreach campaign.

${requiredFields}

${dataContext}

Conversation so far:
${conversationText}

Read Marcus's latest message and the conversation so far. Work out what you already know and what's still genuinely missing. Never ask about something already covered, even if he only mentioned it in passing. Ask about at most one or two missing things at a time, in a natural conversational tone, UK English, no em dashes.

If you now have enough to build the campaign (goal, product, audience, strategy yes/no, success metric and timeline all reasonably covered, even briefly), respond with exactly: "I have everything I need to build this campaign." and nothing else.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "message": string,
  "chips": string[],
  "ready": boolean,
  "progressPercent": number
}

- message: your next reply to Marcus (or the exact "I have everything I need to build this campaign." line if ready).
- chips: 0-4 short suggested quick replies grounded in the real data above (actual role names, actual companies, actual pain points) relevant to whatever you just asked. Empty array if ready or if nothing sensible to suggest.
- ready: true only once goal, product, audience, strategy yes/no, success metric and timeline have all been reasonably covered.
- progressPercent: your best estimate (0-100) of how much of the required info has been gathered so far.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 600,
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
      message: parsed.message || 'Could you tell me a bit more about this campaign?',
      chips: parsed.chips || [],
      ready: !!parsed.ready,
      progressPercent: typeof parsed.progressPercent === 'number' ? Math.max(0, Math.min(100, parsed.progressPercent)) : 0
    });
  } catch (err) {
    console.error('Campaign chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/build', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { conversationHistory } = req.body;
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) {
    return res.status(400).json({ error: 'conversationHistory is required' });
  }

  try {
    const { contacts, bookedCount, conversionRate } = await fetchCampaignContext();
    const conversationText = conversationHistory.map(m => `${m.role === 'assistant' ? 'Assistant' : 'Marcus'}: ${m.content}`).join('\n');

    const prompt = `You are building an outreach campaign for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy, based on this setup conversation with Marcus:

${conversationText}

Here is the full contact list synced from Airtable to match against the target audience described above:
${JSON.stringify(contacts, null, 2)}

Historical data: ${bookedCount} of ${contacts.length} contacts overall have converted to a booking (${conversionRate}% historical conversion rate). Use this as the basis for an honest estimate, don't invent a different number.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "campaignName": string,
  "goal": string,
  "targetSegmentSummary": string,
  "product": string,
  "pitchAngle": string,
  "objectionHandling": string,
  "successMetric": string,
  "matchedContactNames": string[],
  "sequence": {
    "message1": { "type": string, "content": string, "timing": string },
    "followUp1": { "type": string, "content": string, "timing": string },
    "followUp2": { "type": string, "content": string, "timing": string }
  },
  "strategyBrief": string,
  "estimatedConversions": string
}

Guidance:
- goal: one short sentence summarising the campaign's goal, drawn from the conversation.
- product: the product or service being promoted, drawn from the conversation.
- pitchAngle: 2-3 sentences on the specific angle/hook this campaign leads with and why it should land with this audience.
- objectionHandling: 2-3 sentences on the most likely objection this audience will raise and how to handle it.
- successMetric: one short phrase for what counts as success (e.g. "Booked discovery calls", "Workshop bookings").
- matchedContactNames: full names of contacts from the list above whose role, company or notes plausibly match the audience described in the conversation. Only include contacts that actually appear in the list above. Return an empty array if nothing matches rather than inventing names.
- sequence: three outreach stages. "type" is one of "LinkedIn message", "Email", "Call" - pick whatever fits the conversation, default to "LinkedIn message" if nothing was specified. If an existing strategy/script was mentioned in the conversation, adapt it rather than starting from scratch. Otherwise write fresh copy. UK English, no em dashes, peer to peer tone, one observation and one question per message, 3-4 sentences, signed off "Marcus". "timing" is when to send relative to the previous step, e.g. "Day 0", "3 days after message 1", "7 days after follow-up 1".
- strategyBrief: 3-5 sentences summarising the angle and why it should work for this audience.
- estimatedConversions: one or two sentences estimating likely bookings, grounded in the historical conversion rate above and the number of matched contacts. Be honest if the sample is too small to be confident.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
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

    let campaign;
    try {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      campaign = JSON.parse(jsonMatch ? jsonMatch[0] : block.text);
    } catch (parseErr) {
      throw new Error('Could not parse Claude response as JSON');
    }

    res.json({
      campaignName: campaign.campaignName || 'Untitled campaign',
      goal: campaign.goal || '',
      targetSegmentSummary: campaign.targetSegmentSummary || '',
      product: campaign.product || '',
      pitchAngle: campaign.pitchAngle || '',
      objectionHandling: campaign.objectionHandling || '',
      successMetric: campaign.successMetric || '',
      matchedContactNames: campaign.matchedContactNames || [],
      sequence: campaign.sequence || {},
      strategyBrief: campaign.strategyBrief || '',
      estimatedConversions: campaign.estimatedConversions || '',
      contactPoolSize: contacts.length
    });
  } catch (err) {
    console.error('Campaign build error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CAMPAIGN DETAIL: ANALYTICS + AI INSIGHTS =====================
// :id in both routes below is the campaign's NAME, URL-encoded - there is no
// separate stable Airtable record id tracked client-side, and every other
// campaign route (PATCH /api/campaign/status) already resolves by Name, so
// this matches the existing lookup convention rather than inventing a new one.

function computeCampaignAnalytics(campaign, contacts, touchPoints, conversions) {
  const nameToId = {};
  contacts.forEach(c => { if (c.name) nameToId[c.name] = c.id; });

  const targetNames = (campaign.contactNamesRaw || '').split(',').map(s => s.trim()).filter(Boolean);
  const targetRecordIds = targetNames.map(n => nameToId[n]).filter(Boolean);

  const campaignTouchPoints = touchPoints.filter(tp =>
    tp.contact && targetRecordIds.includes(tp.contact) &&
    (!campaign.startDate || !tp.date || tp.date >= campaign.startDate)
  );

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const touchPointsSentThisWeek = campaignTouchPoints.filter(tp => tp.date && new Date(tp.date) >= oneWeekAgo).length;

  const replies = campaignTouchPoints.filter(tp => tp.outcome === 'Replied').length;
  const replyRate = campaignTouchPoints.length ? Math.round((replies / campaignTouchPoints.length) * 100) : 0;

  const campaignConversions = conversions.filter(cv => cv.campaign === campaign.name);
  const bookings = campaignConversions.length;
  const contactsTargeted = targetNames.length;
  const bookingRate = contactsTargeted ? Math.round((bookings / contactsTargeted) * 100) : 0;

  const touchCounts = campaignConversions.map(cv => cv.touchPointCount).filter(n => typeof n === 'number' && n > 0);
  const avgTouchPointsToConvert = touchCounts.length
    ? Math.round((touchCounts.reduce((s, n) => s + n, 0) / touchCounts.length) * 10) / 10
    : null;

  const activityOverTime = [];
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const count = campaignTouchPoints.filter(tp => tp.date && new Date(tp.date) >= weekStart && new Date(tp.date) < weekEnd).length;
    activityOverTime.push({ weekStart: weekStart.toISOString().slice(0, 10), touchPoints: count });
  }

  return {
    contactsTargeted,
    touchPointsSentThisWeek,
    replyRate,
    bookingRate,
    conversionRate: bookingRate,
    avgTouchPointsToConvert,
    activityOverTime
  };
}

function computeHistoricalCampaignAverage(campaigns, contacts, touchPoints, conversions, excludeName) {
  const others = campaigns.filter(c => c.name !== excludeName && c.status !== 'Draft');
  const perf = computeCampaignPerformance(others, contacts, touchPoints, conversions);
  const rates = perf.map(p => p.conversionRate);
  const avgConversionRate = rates.length ? Math.round(rates.reduce((s, n) => s + n, 0) / rates.length) : null;

  const touchCounts = conversions.filter(cv => cv.campaign !== excludeName).map(cv => cv.touchPointCount).filter(n => typeof n === 'number' && n > 0);
  const avgTouchPointsToConvert = touchCounts.length
    ? Math.round((touchCounts.reduce((s, n) => s + n, 0) / touchCounts.length) * 10) / 10
    : null;

  return { avgConversionRate, avgTouchPointsToConvert };
}

app.get('/api/campaign/:id/analytics', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);

  try {
    const [contactsData, touchPointsData, conversions, campaigns] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchConversions(),
      fetchCampaigns()
    ]);

    const campaign = campaigns.find(c => c.name === campaignName);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found in Airtable' });

    const contacts = (contactsData.records || []).map(r => ({ id: r.id, name: r.fields['Full Name'] || '' }));
    const touchPoints = (touchPointsData.records || []).map(r => ({
      contact: (r.fields['Contact'] || [])[0] || null,
      date: r.fields['Date'] || '',
      outcome: r.fields['Outcome'] || ''
    }));

    const analytics = computeCampaignAnalytics(campaign, contacts, touchPoints, conversions);
    const historicalComparison = computeHistoricalCampaignAverage(campaigns, contacts, touchPoints, conversions, campaignName);

    res.json({ ...analytics, historicalComparison, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Campaign analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaign/:id/insights', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);

  try {
    const [contactsData, touchPointsData, conversions, campaigns, learningData] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchConversions(),
      fetchCampaigns(),
      fetchLearningData()
    ]);

    const campaign = campaigns.find(c => c.name === campaignName);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found in Airtable' });

    const contacts = (contactsData.records || []).map(r => ({
      id: r.id,
      name: r.fields['Full Name'] || '',
      role: r.fields['Job Title'] || '',
      company: r.fields['Company'] || '',
      journeyStage: r.fields['Journey Stage'] || ''
    }));
    const touchPoints = (touchPointsData.records || []).map(r => ({
      contact: (r.fields['Contact'] || [])[0] || null,
      date: r.fields['Date'] || '',
      type: r.fields['Type'] || '',
      outcome: r.fields['Outcome'] || ''
    }));

    const nameToId = {};
    contacts.forEach(c => { if (c.name) nameToId[c.name] = c.id; });
    const targetNames = (campaign.contactNamesRaw || '').split(',').map(s => s.trim()).filter(Boolean);
    const targetRecordIds = targetNames.map(n => nameToId[n]).filter(Boolean);

    const campaignContacts = contacts.filter(c => targetRecordIds.includes(c.id));
    const campaignTouchPoints = touchPoints.filter(tp => tp.contact && targetRecordIds.includes(tp.contact));
    const campaignConversions = conversions.filter(cv => cv.campaign === campaignName);

    const prompt = `You are the campaign intelligence layer for T2C Outreach, analysing one specific campaign, "${campaignName}", for Twenty2 Collective, a Perth-based Agile and change consultancy.

CAMPAIGN CONTACTS (${campaignContacts.length}):
${JSON.stringify(campaignContacts, null, 2)}

CAMPAIGN TOUCH POINTS (${campaignTouchPoints.length}):
${JSON.stringify(campaignTouchPoints, null, 2)}

CAMPAIGN CONVERSIONS/BOOKINGS (${campaignConversions.length}):
${JSON.stringify(campaignConversions, null, 2)}

T2C-WIDE HISTORICAL CONVERSION DATA for comparison (${conversions.length} conversions across all campaigns - use this to sharpen insights, e.g. spotting when this campaign under/over-performs the norm):
${conversionsContext(conversions)}

LEARNING DATA on file (${learningData.length} analyses):
${learningDataContext(learningData)}

Surface 3-5 specific, numbers-backed insights about THIS campaign only, in the style of: "8 contacts in this campaign haven't been touched in 14 days", "Your reply rate is 2x higher when messaging on Tuesday", "3 contacts have reached 5 touch points and are campaign-ready for a direct pitch." Every number must be counted from the actual data above, never invented or estimated. Compare against the T2C-wide historical data where it sharpens the insight.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "insights": string[] }

If there isn't enough data yet for a confident insight, return fewer than 5 rather than padding with generic advice.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1200,
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
      insights: parsed.insights || [],
      contactCount: campaignContacts.length,
      touchPointCount: campaignTouchPoints.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Campaign insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CAMPAIGN > SALES TAB =====================
// Deal log entries and transcript scoring both write to a "Sales Log"
// table, mirroring the Learning Data pattern elsewhere in this file - the
// table is app-specific and may not exist in every base yet, so failures
// are caught and logged rather than treated as fatal. The client keeps
// campaign.deals/transcriptAnalyses locally regardless, same as bookings
// and touch points elsewhere in the app (local state is the source of
// truth, Airtable is a best-effort mirror).

// Records one entry from the Sales tab's deal log against the Sales Log
// table, tagged with the campaign name/id so it rolls up into account-level
// intelligence alongside everything else that table feeds.
app.post('/api/campaign/:id/sales/deal', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const { campaignId, contactName, company, outcome, value, notes, date } = req.body;
  if (!contactName) return res.status(400).json({ error: 'contactName is required' });

  try {
    await airtableRequest('POST', 'Sales Log', {
      records: [{
        fields: {
          'Campaign': campaignName,
          'Campaign ID': campaignId || '',
          'Contact Name': contactName,
          'Company': company || '',
          'Outcome': outcome || 'in progress',
          'Deal Value': value || 0,
          'Notes': notes || '',
          'Date': date || new Date().toISOString().slice(0, 10)
        }
      }],
      typecast: true
    });
    res.json({ success: true });
  } catch (err) {
    console.warn('Sales Log write failed (table may not exist yet):', err.message);
    // Non-fatal - the deal is already saved in the app's own local state,
    // which is what the Sales tab actually reads from.
    res.json({ success: false, reason: err.message });
  }
});

// Scores a pasted/uploaded sales call transcript against this campaign's
// Strategy (goal, ICP, pitch angle, objection handling, sequence
// templates): did the call follow the script, which CTAs came up, what
// objections were raised. Saves the analysis to the Sales Log table,
// tagged with the campaign, so it feeds account-level intelligence the
// same way every other Learning Data-style upload in this app does.
app.post('/api/campaign/:id/sales/analyze-transcript', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const { campaignId, transcript, fileBase64, fileMediaType, strategy } = req.body;
  if (!transcript && !fileBase64) return res.status(400).json({ error: 'transcript or fileBase64 is required' });

  try {
    const s = strategy || {};
    const sequenceText = s.sequence ? JSON.stringify(s.sequence) : 'not specified';

    const analyzePrompt = `You are scoring a sales conversation transcript for the campaign "${campaignName}" at Twenty2 Collective, a Perth-based Agile and change consultancy, against that campaign's Strategy.

Campaign goal: ${s.goal || 'not specified'}
Target ICP: ${s.targetSegmentSummary || 'not specified'}
Pitch angle: ${s.pitchAngle || 'not specified'}
Objection handling playbook: ${s.objectionHandling || 'not specified'}
Sequence/message templates: ${sequenceText}

${transcript ? `Transcript:\n${transcript}` : 'Read the attached transcript document.'}

Score how closely the conversation followed the campaign's script and strategy, which CTAs from the strategy were actually used, and what objections came up. Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "scriptAdherence": string, "summary": string, "ctasUsed": string[], "objectionsRaised": string[], "recommendations": string[] }

"scriptAdherence" should be a short label like "High", "Medium", "Low" followed by a one-line reason. "summary" is 2-3 sentences on how the call went overall.`;

    const content = fileBase64
      ? [
          { type: 'document', source: { type: 'base64', media_type: fileMediaType || 'application/pdf', data: fileBase64 } },
          { type: 'text', text: analyzePrompt }
        ]
      : analyzePrompt;

    const parsed = await callClaudeJson(content, 1200);
    const dateLabel = new Date().toISOString().slice(0, 10);

    if (AIRTABLE_API_KEY) {
      try {
        await airtableRequest('POST', 'Sales Log', {
          records: [{
            fields: {
              'Campaign': campaignName,
              'Campaign ID': campaignId || '',
              'Type': 'Transcript Analysis',
              'Script Adherence': parsed.scriptAdherence || '',
              'Notes': parsed.summary || '',
              'CTAs Used': (parsed.ctasUsed || []).join(', '),
              'Objections Raised': (parsed.objectionsRaised || []).join(', '),
              'Date': dateLabel
            }
          }],
          typecast: true
        });
      } catch (writeErr) {
        console.warn('Sales Log transcript analysis write failed (table may not exist yet):', writeErr.message);
      }
    }

    res.json({
      success: true,
      scriptAdherence: parsed.scriptAdherence || '',
      summary: parsed.summary || '',
      ctasUsed: parsed.ctasUsed || [],
      objectionsRaised: parsed.objectionsRaised || [],
      recommendations: parsed.recommendations || []
    });
  } catch (err) {
    console.error('Transcript analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CONTEXT TAB =====================
// Marcus's primary data input hub. Fields referenced below that don't exist
// yet on Contacts/Companies need to be created in Airtable (unconfirmed
// exact names, following this app's existing naming style):
//   Contacts: "Sequence Stage" (single select, values below), "AI Summary"
//   (long text), "Conversation Context" (long text), "Next Message Draft"
//   (long text).
//   Companies: "AI Summary" (long text).
//   Touch Points: "Company" (linked record) - new, see the touchpoint
//   route above.
//   Learning Data: "Company", "Outcome", "ICP Role", "Key Signals",
//   "Source" - new fields on the existing table (it already has
//   Type/Analysis/Record Count/Date from the Learning Data upload feature;
//   this reuses the same table with additional fields rather than a
//   second table, matching the brief's literal "write a record to the
//   Learning Data table").
// Journey Stage is left untouched everywhere in this section - it keeps
// driving Dashboard prioritisation exactly as before. Sequence Stage is
// the new, separate, more granular field this tab reads and writes.

// GET /api/context/data - not one of the five endpoints named in the brief,
// but necessary supporting infrastructure: the Company dropdown and
// per-company Contact multi-select in the Touch Point Logger have nothing
// to populate from without it, and there was no existing route that
// returns Companies at all (only create/update-linkedin routes existed).
app.get('/api/context/data', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const [companiesData, contactsData, touchPointsData] = await Promise.all([
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points')
    ]);

    const companies = (companiesData.records || [])
      .map(r => ({ id: r.id, name: r.fields['Company Name'] || '' }))
      .filter(c => c.name);

    const touchPointsByContact = {};
    (touchPointsData.records || []).forEach(r => {
      (r.fields['Contact'] || []).forEach(cid => {
        if (!touchPointsByContact[cid]) touchPointsByContact[cid] = [];
        touchPointsByContact[cid].push({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '' });
      });
    });

    const contacts = (contactsData.records || [])
      .map(r => {
        const companyIds = r.fields['Company'] || [];
        const recentTouchPoints = (touchPointsByContact[r.id] || [])
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 3);
        return {
          id: r.id,
          name: r.fields['Full Name'] || '',
          companyId: companyIds[0] || null,
          role: r.fields['Job Title'] || '',
          journeyStage: r.fields['Journey Stage'] || '',
          sequenceStage: r.fields['Sequence Stage'] || '',
          aiSummary: r.fields['AI Summary'] || '',
          conversationContext: r.fields['Conversation Context'] || '',
          nextMessageDraft: r.fields['Next Message Draft'] || '',
          recentTouchPoints
        };
      })
      .filter(c => c.name);

    res.json({ companies, contacts });
  } catch (err) {
    console.error('Context data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/context/contact-fields - also not one of the five named
// endpoints, but the LinkedIn Connections CSV card needs to write Journey
// Stage + Sequence Stage together by record id, and the existing PATCH
// /api/airtable/contact/stage route works by name search and maps a
// found/opened/connected/messaging/booked app-state enum to Journey Stage
// rather than accepting either field directly - reusing it would have
// meant overloading it with a second, unrelated update shape.
app.patch('/api/context/contact-fields', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactId, journeyStage, sequenceStage } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  try {
    const fields = {};
    if (journeyStage) fields['Journey Stage'] = journeyStage;
    if (sequenceStage) fields['Sequence Stage'] = sequenceStage;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'journeyStage or sequenceStage is required' });

    await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields }] });
    res.json({ success: true });
  } catch (err) {
    console.error('Context contact-fields update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context/debrief-questions', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { contactId } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  try {
    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found in Airtable' });
    const f = contactRecord.fields || {};

    const touchPointsData = await airtableRequest('GET', 'Touch Points');
    const recentTouchPoints = (touchPointsData.records || [])
      .filter(r => (r.fields['Contact'] || []).includes(contactId))
      .map(r => ({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '' }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 3);

    const prompt = `You are prepping Marcus for a touch point with a contact at Twenty2 Collective, a Perth-based Agile and change consultancy.

Contact: ${f['Full Name'] || ''}, ${f['Job Title'] || ''}.
Journey stage: ${f['Journey Stage'] || 'unknown'}.
Current AI Summary: ${f['AI Summary'] || '(none yet)'}

Last 3 touch points (most recent first):
${JSON.stringify(recentTouchPoints, null, 2)}

Return 2-3 short, targeted questions Marcus should answer after this touch point to capture what actually matters given where this contact is right now - not generic questions.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "questions": string[] }`;

    const parsed = await callClaudeJson(prompt, 400);
    res.json({ questions: parsed.questions || [] });
  } catch (err) {
    console.error('Debrief questions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context/update-summaries', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { contactIds, companyId } = req.body;
  if ((!contactIds || !contactIds.length) && !companyId) {
    return res.status(400).json({ error: 'contactIds or companyId is required' });
  }

  try {
    const [contactsData, touchPointsData] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points')
    ]);
    const contactsById = {};
    (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });

    const updatedContacts = [];
    for (const contactId of (contactIds || [])) {
      const record = contactsById[contactId];
      if (!record) continue;
      const f = record.fields || {};
      const touchPoints = (touchPointsData.records || [])
        .filter(r => (r.fields['Contact'] || []).includes(contactId))
        .map(r => ({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '', outcome: r.fields['Outcome'] || '' }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      const prompt = `You are maintaining the AI Summary field for a contact in T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Contact: ${f['Full Name'] || ''}, ${f['Job Title'] || ''}.
Journey stage: ${f['Journey Stage'] || ''}. Sequence stage: ${f['Sequence Stage'] || ''}.

EXISTING AI SUMMARY (this is the current intelligence brief - preserve everything useful in it, never lose information that isn't superseded by newer touch points):
${f['AI Summary'] || '(no summary yet)'}

ALL TOUCH POINTS ON FILE (${touchPoints.length}, most recent first):
${JSON.stringify(touchPoints, null, 2)}

Rewrite the AI Summary as a concise intelligence brief for Marcus to read before his next touch point with this contact. Cover: who they are, where the relationship stands, key pain points/signals raised, what's been discussed, and what to do next. Preserve every piece of real information from the existing summary that is still relevant - only replace details that newer touch points have superseded. Never produce a summary shorter or less informative than the existing one unless information has genuinely become outdated. UK English, no em dashes. Return only the summary text, nothing else.`;

      const summary = await callClaudeText(prompt, 700);
      await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'AI Summary': summary } }] });
      updatedContacts.push({ contactId, name: f['Full Name'] || '', summary });
    }

    let companyResult = null;
    if (companyId) {
      const companyRecord = await airtableGetRecord('Companies', companyId);
      if (companyRecord) {
        const cf = companyRecord.fields || {};
        const companyContactIds = (contactsData.records || [])
          .filter(r => (r.fields['Company'] || []).includes(companyId))
          .map(r => r.id);
        const companyTouchPoints = (touchPointsData.records || [])
          .filter(r => (r.fields['Contact'] || []).some(cid => companyContactIds.includes(cid)))
          .map(r => ({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '' }))
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        const prompt = `You are maintaining the AI Summary field for a company account in T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Company: ${cf['Company Name'] || ''}

EXISTING AI SUMMARY (preserve everything useful, never lose information unless a newer touch point supersedes it):
${cf['AI Summary'] || '(no summary yet)'}

ALL TOUCH POINTS ACROSS EVERY CONTACT AT THIS COMPANY (${companyTouchPoints.length}, most recent first):
${JSON.stringify(companyTouchPoints, null, 2)}

Rewrite the AI Summary as a concise account-level intelligence brief: who's engaged, what's been raised across contacts, signals worth acting on, and where the account stands overall. Preserve every real detail from the existing summary that newer touch points haven't superseded. Never produce something shorter or less informative than what's there now unless it's genuinely outdated. UK English, no em dashes. Return only the summary text, nothing else.`;

        const summary = await callClaudeText(prompt, 700);
        await airtableRequest('PATCH', 'Companies', { records: [{ id: companyId, fields: { 'AI Summary': summary } }] });
        companyResult = { companyId, name: cf['Company Name'] || '', summary };
      }
    }

    res.json({ success: true, contacts: updatedContacts, company: companyResult });
  } catch (err) {
    console.error('Update summaries error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Advancing FROM "Pending Reply (M1)"/"(M2)" isn't explicitly in the brief
// (which only describes advancing from "Message 1/2 Sent"), but leaving no
// forward path once a contact is already waiting on a reply would be a
// clear gap - a reply landing while a contact sits in "Pending Reply (M1)"
// should still advance them the same way "Message 1 Sent" would.
const SEQUENCE_STAGE_ADVANCE = {
  'Message 1 Sent': { replied: 'Ready for Message 2', noReply: 'Pending Reply (M1)' },
  'Pending Reply (M1)': { replied: 'Ready for Message 2', noReply: 'Pending Reply (M1)' },
  'Message 2 Sent': { replied: 'Ready for Message 3', noReply: 'Pending Reply (M2)' },
  'Pending Reply (M2)': { replied: 'Ready for Message 3', noReply: 'Pending Reply (M2)' }
};

app.post('/api/context/parse-screenshot', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, text } = req.body;
  if (!image && !text) return res.status(400).json({ error: 'image or text is required' });

  try {
    const extractPrompt = `You are reading a LinkedIn DM or email exchange for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

${text ? `Here is the pasted conversation text:\n${text}` : 'Read the attached screenshot of the conversation.'}

Extract: the other person's name, a short summary of the message content/exchange, and whether they have replied (i.e. there is a message from them, not just Marcus).

If you cannot confidently identify the contact's name or read the message content, do not guess - set "confident" to false and explain why in "reason".

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "confident": boolean, "reason": string, "contactName": string, "messageSummary": string, "replied": boolean }`;

    const content = image
      ? [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: extractPrompt }
        ]
      : extractPrompt;

    const parsed = await callClaudeJson(content, 800);

    if (!parsed.confident) {
      return res.json({ success: false, reason: parsed.reason || 'Could not read this screenshot clearly. Please re-upload a cleaner crop of the conversation.' });
    }

    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', parsed.contactName);
    if (!contactRecord) {
      return res.json({ success: false, reason: `Could not match "${parsed.contactName}" to a contact in Airtable.` });
    }

    const f = contactRecord.fields || {};
    const existingContext = f['Conversation Context'] || '';
    const dateLabel = new Date().toISOString().slice(0, 10);
    const newContext = (existingContext ? existingContext + '\n\n' : '') + `[${dateLabel}] ${parsed.messageSummary}`;

    const currentStage = f['Sequence Stage'] || '';
    const advance = SEQUENCE_STAGE_ADVANCE[currentStage];
    const newStage = advance ? (parsed.replied ? advance.replied : advance.noReply) : currentStage;

    const updateFields = { 'Conversation Context': newContext };
    if (newStage !== currentStage) updateFields['Sequence Stage'] = newStage;

    let draft = null;
    if (newStage.startsWith('Ready for Message')) {
      const draftPrompt = `You are drafting the next LinkedIn message for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Contact: ${f['Full Name'] || ''}, ${f['Job Title'] || ''}.
AI Summary: ${f['AI Summary'] || 'none yet'}
Conversation so far: ${newContext}

Write the next message in the conversation, following on naturally from what they just said. UK English, no em dashes, peer to peer tone, 3-4 sentences, one observation and one question, signed off "Marcus". Return only the message text.`;
      draft = await callClaudeText(draftPrompt, 400);
      updateFields['Next Message Draft'] = draft;
    }

    await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactRecord.id, fields: updateFields }] });

    res.json({
      success: true,
      contactName: f['Full Name'] || parsed.contactName,
      contactId: contactRecord.id,
      messageSummary: parsed.messageSummary,
      replied: parsed.replied,
      previousStage: currentStage,
      newStage,
      draft
    });
  } catch (err) {
    console.error('Parse screenshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context/log-content', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { content, targetType, targetName, campaignId, campaignName } = req.body;
  if (!content || !targetType || !targetName) return res.status(400).json({ error: 'content, targetType and targetName are required' });
  if (targetType !== 'Company' && targetType !== 'Contact') return res.status(400).json({ error: 'targetType must be Company or Contact' });

  try {
    const table = targetType === 'Company' ? 'Companies' : 'Contacts';
    const fieldName = targetType === 'Company' ? 'Company Name' : 'Full Name';
    const record = await findRecordByFieldName(table, fieldName, targetName);
    if (!record) return res.json({ success: false, reason: `Could not find a ${targetType.toLowerCase()} named "${targetName}" in Airtable.` });

    const prompt = `Summarise this content into one short, dated intelligence signal for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM. It's about: ${targetName}.

Content:
${content}

Return ONLY the single summary line, in this exact style: "[${new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}] <summary>. Source: <inferred source type, e.g. LinkedIn post, news article, personal note>." Nothing else.`;

    let signalLine = await callClaudeText(prompt, 200);
    // Tagged when saved from a campaign's Intelligence tab (see the
    // matching note on POST /api/airtable/touchpoint above) - kept in the
    // summary text itself since there's no confirmed "Campaign" field on
    // Companies/Contacts to write to instead.
    if (campaignName) signalLine += ` Campaign: ${campaignName}.`;

    const existingSummary = record.fields['AI Summary'] || '';
    const newSummary = existingSummary ? existingSummary + '\n' + signalLine : signalLine;

    await airtableRequest('PATCH', table, { records: [{ id: record.id, fields: { 'AI Summary': newSummary } }] });

    res.json({ success: true, targetId: record.id, appendedLine: signalLine });
  } catch (err) {
    console.error('Log content error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/context/historical-upload', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { content, fileBase64, fileMediaType, tag, targetType, targetName, campaignId, campaignName } = req.body;
  if (!content && !fileBase64) return res.status(400).json({ error: 'content or fileBase64 is required' });
  if (!tag || !targetType || !targetName) return res.status(400).json({ error: 'tag, targetType and targetName are required' });
  if (targetType !== 'Company' && targetType !== 'Contact') return res.status(400).json({ error: 'targetType must be Company or Contact' });

  const validTags = ['Past Customer', 'Past Deal', 'Conversation History', 'General Background'];
  if (!validTags.includes(tag)) return res.status(400).json({ error: 'tag must be one of: ' + validTags.join(', ') });

  try {
    const table = targetType === 'Company' ? 'Companies' : 'Contacts';
    const fieldName = targetType === 'Company' ? 'Company Name' : 'Full Name';
    const record = await findRecordByFieldName(table, fieldName, targetName);
    if (!record) return res.json({ success: false, reason: `Could not find a ${targetType.toLowerCase()} named "${targetName}" in Airtable.` });

    const extractPrompt = `You are extracting historical context for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM. This document is tagged "${tag}" and is about: ${targetName}.

${content ? `Content:\n${content}` : 'Read the attached document.'}

Extract key signals: decision makers, pain points, outcomes, objections, and timelines where present. Write a structured summary, clearly marked as historical context with the tag and today's date. Also separately identify: the ICP role of the key decision maker (if determinable), a one-line outcome (if this was a deal/customer), and a short comma-separated list of key signals.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "summaryForRecord": string, "icpRole": string, "outcome": string, "keySignals": string }`;

    const content_ = fileBase64
      ? [
          { type: 'document', source: { type: 'base64', media_type: fileMediaType || 'application/pdf', data: fileBase64 } },
          { type: 'text', text: extractPrompt }
        ]
      : extractPrompt;

    const parsed = await callClaudeJson(content_, 1500);

    const dateLabel = new Date().toISOString().slice(0, 10);
    const campaignTag = campaignName ? ` - campaign: ${campaignName}` : '';
    const historicalBlock = `\n\n[Historical context - ${tag} - added ${dateLabel}${campaignTag}]\n${parsed.summaryForRecord || ''}`;
    const newSummary = (record.fields['AI Summary'] || '') + historicalBlock;

    await airtableRequest('PATCH', table, { records: [{ id: record.id, fields: { 'AI Summary': newSummary } }] });

    // No plain-text "Company" field exists on Learning Data - only linked
    // "Related Company"/"Related Contact" fields, so this links back to
    // the record already resolved above instead of writing a name string.
    // "Date" is also "Created Date" on the real table, same as elsewhere
    // Learning Data is written.
    let learningDataWritten = false;
    if (tag === 'Past Customer' || tag === 'Past Deal') {
      const learningFields = {
        'Type': tag,
        'Outcome': parsed.outcome || '',
        'ICP Role': parsed.icpRole || '',
        'Key Signals': parsed.keySignals || '',
        'Source': 'Historical upload',
        'Created Date': dateLabel
      };
      if (targetType === 'Company') learningFields['Related Company'] = [record.id];
      else learningFields['Related Contact'] = [record.id];

      // typecast lets Airtable add "Past Customer"/"Past Deal" as new
      // choices on the Type field automatically - it currently only has
      // "Customer Analysis"/"Deal Analysis", and without this the write
      // would be rejected outright since Type is a single select field.
      await airtableRequest('POST', 'Learning Data', { records: [{ fields: learningFields }], typecast: true });
      learningDataWritten = true;
    }

    res.json({ success: true, targetId: record.id, summary: parsed.summaryForRecord || '', learningDataWritten });
  } catch (err) {
    console.error('Historical upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
