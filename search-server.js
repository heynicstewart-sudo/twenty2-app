// v2
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

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

// Fetches every full record (not just the first page) in a table, following
// Airtable's `offset` pagination cursor. The plain airtableRequest('GET',
// table) used elsewhere in this file only returns the first 100 records -
// fine for routes that just display/search, but not safe for the Trigify
// sync routes below, which need every Contact regardless of table size.
async function airtableFetchAllRecords(table) {
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs.toString()}`, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Airtable error ${res.status}: ${err}`); }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

// Campaign lookup by name for the Sales tab routes - fetches the whole
// Campaigns table and matches by exact string equality in JS instead of
// going through findRecordByFieldName's filterByFormula. That formula gets
// the campaign name interpolated raw into `{Name}="${value}"`, so any name
// containing a double quote (or other formula-special character) silently
// breaks the match and the campaign comes back "not found" even though it
// exists - the same "fetch everything, filter in memory" convention
// /api/campaign/:id/analytics already uses for this exact table/purpose
// (via fetchCampaigns()) doesn't have that failure mode, so Sales-tab
// campaign resolution uses it too.
async function findCampaignRecordByName(campaignName) {
  if (!campaignName) return null;
  const data = await airtableRequest('GET', 'Campaigns');
  return (data.records || []).find(r => (r.fields['Name'] || '') === campaignName) || null;
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
      if (icpRoleCategory) {
        await airtableRequest('PATCH', 'Contacts', {
          records: [{ id: existing.id, fields: { 'ICP Role Category': icpRoleCategory } }],
          typecast: true
        });
      }
      return res.json({ success: true, skipped: true, recordId: existing.id });
    }

    const fields = {
      'Full Name': name,
      'Job Title': role || '',
      'LinkedIn URL': linkedinUrl || '',
      'Journey Stage': mapStateToStage(contactState),
      'Notes': notes || '',
      'ICP Role Category': icpRoleCategory || ''
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
      records: [{ fields }],
      typecast: true
    });

    if (linkedinUrl) {
      trigifyCreateContactSearch(data.records[0].id, name, linkedinUrl)
        .catch(err => console.warn('Could not create Trigify search for new contact (non-fatal):', err.message));
    }

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
  const { name, goal, product, targetIcp, contactIds, sequenceTemplates, strategyNotes, pitchAngle, objectionHandling, successMetric, startDate, status, ctas, contentContext } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const existing = await findCampaignRecordByName(name);

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
      'Status': status || 'Draft',
      'CTAs': ctas || '',
      'Content Context': contentContext || ''
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
    const record = await findCampaignRecordByName(name);
    if (!record) return res.json({ success: false, message: 'Campaign not found in Airtable' });

    await airtableRequest('PATCH', 'Campaigns', {
      records: [{ id: record.id, fields: { 'Status': status } }],
      typecast: true
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Campaign status update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Permanently deletes a campaign's Campaigns record in Airtable. Scoped to
// just that record - does not cascade-delete its Campaign Contacts rows,
// Deals, or Touch Points, since that wasn't asked for and would turn one
// bounded delete into a much larger destructive operation.
app.delete('/api/campaign/:id', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const campaignName = decodeURIComponent(req.params.id);

  try {
    const record = await findCampaignRecordByName(campaignName);
    if (!record) return res.json({ success: true, alreadyDeleted: true });

    const url = `${AIRTABLE_URL}/Campaigns?records[]=${encodeURIComponent(record.id)}`;
    const resp = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
    if (!resp.ok) { const err = await resp.text(); throw new Error(`Airtable error ${resp.status}: ${err}`); }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete campaign error:', err.message);
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
// Touch Points table now has a "Campaign" link field, so the tag is written
// both into Summary (readable at a glance) and as a real link once the
// Campaign record is resolved by name - wrapped in try/catch and non-fatal
// since it's still a secondary write to the primary save.
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
        const campaignRecord = await findCampaignRecordByName(campaignName);
        if (campaignRecord) {
          await airtableRequest('PATCH', 'Touch Points', { records: [{ id: recordId, fields: { 'Campaign': [campaignRecord.id] } }] });
        }
      } catch (tagErr) {
        console.warn('Best-effort Campaign field write on Touch Points failed:', tagErr.message);
      }
    }

    res.json({ success: true, recordId });
    detectContentSignals().catch(err => console.warn('Content signal detection trigger failed:', err.message));
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
// are caught and logged rather than treated as fatal. Deal logging itself
// (below) now targets the real "Deals" table instead - see the Sales tab
// rebuild routes further down this file, after the transcript route.

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

// ===================== SALES TAB (pipeline, scorecards, conversion intelligence, deals, reps) =====================
// Reads/writes the real Deals/Reps tables (both already existed in the
// base, unused until this feature) plus the Stage History/Sentiment fields
// on Campaign Contacts and the Campaign/Message Time/CTA fields on Touch
// Points added alongside this route block. Stage History is the linchpin:
// Sequence Stage is only ever a snapshot, so the pipeline funnel and every
// period-scoped scorecard below read the dated log instead - see
// appendStageHistory/parseStageHistory near SEQUENCE_STAGE_ADVANCE above.

function parseCtaList(ctaText) {
  return (ctaText || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function normalizeCta(s) {
  return (s || '').toLowerCase().trim();
}

function touchPointIsReply(fields) {
  if (fields['Type'] === 'Inbound Reply') return true;
  const outcome = (fields['Outcome'] || '').toLowerCase();
  if (!outcome) return false;
  return outcome !== 'no reply' && !outcome.includes('no reply') && outcome !== 'pending';
}

// "Tuesday 10am" -> { day: 'Tuesday', hour: 22 } (24h). Returns null for
// anything that doesn't match the format Claude is instructed to write.
function parseMessageTime(str) {
  const m = (str || '').match(/^(\w+)\s+(\d{1,2})(am|pm)$/i);
  if (!m) return null;
  const day = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  let hour = parseInt(m[2], 10) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  return { day, hour };
}

function hourBucketLabel(hour) {
  if (hour >= 6 && hour < 11) return 'Morning';
  if (hour >= 11 && hour < 14) return 'Midday';
  if (hour >= 14 && hour < 18) return 'Afternoon';
  if (hour >= 18 && hour < 22) return 'Evening';
  return 'Late night';
}

// Unions the dated Stage History log with the current Sequence Stage, so
// rows created before Stage History existed (whose current stage is real
// but undated) still count correctly for funnel/panel aggregation.
function reachedStageSet(ccRow) {
  const set = new Set(parseStageHistory(ccRow.fields['Stage History']).map(h => h.stage));
  if (ccRow.fields['Sequence Stage']) set.add(ccRow.fields['Sequence Stage']);
  return set;
}

// One batched Claude call across every first name missing Gender, so the
// inference runs once per contact ever rather than once per report load -
// callers are responsible for caching the result back onto Contacts.Gender.
async function inferGendersForNames(fullNames) {
  const firstNames = [...new Set(fullNames.map(n => (n || '').trim().split(/\s+/)[0]).filter(Boolean))];
  if (!firstNames.length) return {};
  const prompt = `For each of these first names, infer the most likely gender based on common usage. Names may be from any culture or nationality. If a name is unisex or you are not confident, use "Unknown" rather than guessing.

Names: ${JSON.stringify(firstNames)}

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "results": [{ "name": string, "gender": "Male"|"Female"|"Unknown" }] }`;
  try {
    const parsed = await callClaudeJson(prompt, 1500);
    const map = {};
    (parsed.results || []).forEach(r => { map[r.name] = r.gender; });
    return map;
  } catch (err) {
    console.warn('Gender inference failed:', err.message);
    return {};
  }
}

// Rewrites Contacts.AI Summary and (if a company is linked) Companies.AI
// Summary, folding in one new signal line alongside everything already on
// file - same prompt shape as /api/context/update-summaries, but scoped to
// a single new signal (e.g. a deal note) rather than a full touch-point
// re-scan. Never throws - callers fire this in the background and don't
// await it, so failures here must not surface as a broken request.
async function refreshContactAndCompanySummaries(contactId, companyId, extraContextLine) {
  try {
    if (contactId) {
      const [contactRecord, touchPointsData] = await Promise.all([
        airtableGetRecord('Contacts', contactId),
        airtableRequest('GET', 'Touch Points')
      ]);
      if (contactRecord) {
        const f = contactRecord.fields || {};
        const touchPoints = (touchPointsData.records || [])
          .filter(r => (r.fields['Contact'] || []).includes(contactId))
          .map(r => ({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '' }))
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        const prompt = `You are maintaining the AI Summary field for a contact in T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Contact: ${f['Full Name'] || ''}, ${f['Job Title'] || ''}.

EXISTING AI SUMMARY (preserve everything useful, never lose information unless a newer signal supersedes it):
${f['AI Summary'] || '(no summary yet)'}

NEW SIGNAL JUST LOGGED:
${extraContextLine}

ALL TOUCH POINTS ON FILE (${touchPoints.length}, most recent first):
${JSON.stringify(touchPoints, null, 2)}

Rewrite the AI Summary as a concise intelligence brief, folding in the new signal above alongside everything already known. UK English, no em dashes. Return only the summary text, nothing else.`;

        const summary = await callClaudeText(prompt, 700);
        await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'AI Summary': summary } }] });
      }
    }

    if (companyId) {
      const companyRecord = await airtableGetRecord('Companies', companyId);
      if (companyRecord) {
        const cf = companyRecord.fields || {};
        const prompt = `You are maintaining the AI Summary field for a company account in T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Company: ${cf['Company Name'] || ''}

EXISTING AI SUMMARY (preserve everything useful, never lose information unless a newer signal supersedes it):
${cf['AI Summary'] || '(no summary yet)'}

NEW SIGNAL JUST LOGGED (from a deal involving this account):
${extraContextLine}

Rewrite the AI Summary folding in this new signal alongside everything already known about the account. UK English, no em dashes. Return only the summary text, nothing else.`;

        const summary = await callClaudeText(prompt, 700);
        await airtableRequest('PATCH', 'Companies', { records: [{ id: companyId, fields: { 'AI Summary': summary } }] });
      }
    }
  } catch (err) {
    console.warn('Background AI Summary refresh failed (non-fatal):', err.message);
  }
}

// One bulk fetch for Sections 1/2/4/5 of the Sales tab - fetch everything
// once, let the frontend bucket by period locally, same "fetch once" idea
// as campaignPeriodBounds/buildCampaignSeries already use on the frontend
// for the Analytics tab.
app.get('/api/campaign/:id/sales-overview', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const campaignName = decodeURIComponent(req.params.id);
  try {
    const campaignRecord = await findCampaignRecordByName(campaignName);
    if (!campaignRecord) return res.status(404).json({ error: 'Campaign not found' });

    const [ccRows, dealsData, tpData, contactsData, companiesData, repsData] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableRequest('GET', 'Deals'),
      airtableRequest('GET', 'Touch Points'),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Reps')
    ]);

    const contactsById = {}; (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });
    const companiesById = {}; (companiesData.records || []).forEach(r => { companiesById[r.id] = r; });
    const repsById = {}; (repsData.records || []).forEach(r => { repsById[r.id] = r; });

    const myCcRows = ccRows.filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
    const myContactIds = new Set(myCcRows.map(r => (r.fields['Contact'] || [])[0]).filter(Boolean));

    const campaignContacts = myCcRows.map(r => {
      const contactId = (r.fields['Contact'] || [])[0] || null;
      const contact = contactId ? contactsById[contactId] : null;
      const companyId = contact ? (contact.fields['Company'] || [])[0] || null : null;
      const company = companyId ? companiesById[companyId] : null;
      return {
        campaignContactId: r.id,
        contactId,
        contactName: contact ? (contact.fields['Full Name'] || '') : '',
        companyId,
        company: company ? (company.fields['Company Name'] || '') : '',
        sequenceStage: r.fields['Sequence Stage'] || '',
        sentiment: r.fields['Sentiment'] || null,
        stageHistory: parseStageHistory(r.fields['Stage History']),
        addedDate: r.fields['Added Date'] || ''
      };
    }).filter(c => c.contactId);

    const deals = (dealsData.records || [])
      .filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const companyId = (r.fields['Company'] || [])[0] || null;
        const assigneeId = (r.fields['Assignee'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        const company = companyId ? companiesById[companyId] : null;
        const rep = assigneeId ? repsById[assigneeId] : null;
        return {
          id: r.id,
          contactId,
          contactName: contact ? (contact.fields['Full Name'] || '') : '',
          companyId,
          companyName: company ? (company.fields['Company Name'] || '') : '',
          outcome: r.fields['Outcome'] || 'Pending',
          dealValue: r.fields['Deal Value'] || 0,
          assigneeId,
          assigneeName: rep ? (rep.fields['Name'] || '') : '',
          sentiment: r.fields['Sentiment'] || null,
          notes: r.fields['Notes'] || '',
          date: r.fields['Date'] || ''
        };
      });

    const touchPoints = (tpData.records || [])
      .filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id) || (r.fields['Contact'] || []).some(cid => myContactIds.has(cid)))
      .map(r => ({
        contactId: (r.fields['Contact'] || [])[0] || null,
        date: r.fields['Date'] || '',
        type: r.fields['Type'] || '',
        communicationMethod: r.fields['Communication Method'] || '',
        cta: r.fields['CTA'] || '',
        outcome: r.fields['Outcome'] || '',
        messageTime: r.fields['Message Time'] || '',
        replied: touchPointIsReply(r.fields)
      }));

    const reps = (repsData.records || []).map(r => ({ id: r.id, name: r.fields['Name'] || '', email: r.fields['Email'] || '' }));
    const ctas = parseCtaList(campaignRecord.fields['CTAs']);

    res.json({ campaignContacts, deals, touchPoints, reps, ctas, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Sales overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Section 3's six conversion-intelligence panels. Separate from
// sales-overview above because two panels (gender inference) have a Claude
// call + Airtable-write side effect, which shouldn't block the fast bulk
// load the rest of the tab depends on.
app.get('/api/campaign/:id/conversion-intelligence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const campaignName = decodeURIComponent(req.params.id);
  try {
    const campaignRecord = await findCampaignRecordByName(campaignName);
    if (!campaignRecord) return res.status(404).json({ error: 'Campaign not found' });

    const [ccRows, dealsData, tpData, contactsData] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableRequest('GET', 'Deals'),
      airtableRequest('GET', 'Touch Points'),
      airtableRequest('GET', 'Contacts')
    ]);

    const contactsById = {}; (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });

    const myCcRows = ccRows.filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
    const myContactIds = new Set(myCcRows.map(r => (r.fields['Contact'] || [])[0]).filter(Boolean));
    const myDeals = (dealsData.records || []).filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
    const myTouchPoints = (tpData.records || []).filter(r =>
      (r.fields['Campaign'] || []).includes(campaignRecord.id) || (r.fields['Contact'] || []).some(cid => myContactIds.has(cid))
    );

    // Panel 1: which message step converted to a booking
    const stepBuckets = { M1: { total: 0, booked: 0 }, M2: { total: 0, booked: 0 }, M3: { total: 0, booked: 0 } };
    myCcRows.forEach(r => {
      const reached = reachedStageSet(r);
      const booked = reached.has('Meeting Booked');
      let step = null;
      if (reached.has('Message 3 Sent')) step = 'M3';
      else if (reached.has('Message 2 Sent')) step = 'M2';
      else if (reached.has('Message 1 Sent')) step = 'M1';
      if (step) { stepBuckets[step].total++; if (booked) stepBuckets[step].booked++; }
    });
    const messageStepToBooking = Object.entries(stepBuckets).map(([step, v]) => ({ step, total: v.total, booked: v.booked }));

    // Panel 2: which CTA is converting to bookings - exact/substring match
    // for v1, since Campaigns.CTAs and Touch Points.CTA are both free text.
    const ctaList = parseCtaList(campaignRecord.fields['CTAs']);
    const bookedContactIds = new Set(myCcRows.filter(r => reachedStageSet(r).has('Meeting Booked')).map(r => (r.fields['Contact'] || [])[0]));
    const ctaStats = {};
    ctaList.forEach(cta => { ctaStats[cta] = { touches: new Set(), bookings: new Set() }; });
    myTouchPoints.forEach(r => {
      const ctaText = normalizeCta(r.fields['CTA']);
      if (!ctaText) return;
      const contactId = (r.fields['Contact'] || [])[0] || null;
      ctaList.forEach(cta => {
        const norm = normalizeCta(cta);
        if (norm && (ctaText.includes(norm) || norm.includes(ctaText))) {
          if (contactId) {
            ctaStats[cta].touches.add(contactId);
            if (bookedContactIds.has(contactId)) ctaStats[cta].bookings.add(contactId);
          }
        }
      });
    });
    const ctaToBooking = ctaList.map(cta => ({ cta, touches: ctaStats[cta].touches.size, bookings: ctaStats[cta].bookings.size }));

    // Panel 3: response rate by touch point type
    const typeStats = {};
    myTouchPoints.forEach(r => {
      const type = r.fields['Type'] || 'Unknown';
      if (!typeStats[type]) typeStats[type] = { total: 0, replied: 0 };
      typeStats[type].total++;
      if (touchPointIsReply(r.fields)) typeStats[type].replied++;
    });
    const responseRateByType = Object.entries(typeStats).map(([type, v]) => ({ type, total: v.total, replied: v.replied, rate: v.total ? Math.round(v.replied / v.total * 100) : 0 }));

    // Panel 4: response rate by gender - infer + cache once per contact
    const missingGenderContacts = [...myContactIds].map(id => contactsById[id]).filter(c => c && !c.fields['Gender']);
    if (missingGenderContacts.length) {
      const genderMap = await inferGendersForNames(missingGenderContacts.map(c => c.fields['Full Name']));
      const patches = missingGenderContacts.map(c => {
        const firstName = (c.fields['Full Name'] || '').trim().split(/\s+/)[0];
        const gender = genderMap[firstName] || 'Unknown';
        c.fields['Gender'] = gender;
        return { id: c.id, fields: { 'Gender': gender } };
      });
      if (patches.length) await airtableBatchPatch('Contacts', patches);
    }
    const genderStats = { Male: { total: 0, replied: 0 }, Female: { total: 0, replied: 0 }, Unknown: { total: 0, replied: 0 } };
    const repliedContactIds = new Set(myTouchPoints.filter(r => touchPointIsReply(r.fields)).map(r => (r.fields['Contact'] || [])[0]));
    myContactIds.forEach(cid => {
      const c = contactsById[cid];
      const gender = (c && c.fields['Gender']) || 'Unknown';
      if (!genderStats[gender]) genderStats[gender] = { total: 0, replied: 0 };
      genderStats[gender].total++;
      if (repliedContactIds.has(cid)) genderStats[gender].replied++;
    });
    const responseRateByGender = Object.entries(genderStats).map(([gender, v]) => ({ gender, total: v.total, replied: v.replied, rate: v.total ? Math.round(v.replied / v.total * 100) : 0 }));

    // Panel 5: reply sentiment breakdown - union of Deals.Sentiment (once a
    // deal exists) and Campaign Contacts.Sentiment (scored at reply time,
    // before any deal necessarily exists).
    const sentimentCounts = { Positive: 0, Neutral: 0, Cold: 0, Negative: 0 };
    myDeals.forEach(r => { const s = r.fields['Sentiment']; if (s && sentimentCounts[s] !== undefined) sentimentCounts[s]++; });
    myCcRows.forEach(r => { const s = r.fields['Sentiment']; if (s && sentimentCounts[s] !== undefined) sentimentCounts[s]++; });
    const sentimentBreakdown = Object.entries(sentimentCounts).map(([sentiment, count]) => ({ sentiment, count }));

    // Panel 6: best time to message, from Touch Points.Message Time
    const heatmap = {};
    myTouchPoints.forEach(r => {
      const parsed = parseMessageTime(r.fields['Message Time']);
      if (!parsed) return;
      const bucket = hourBucketLabel(parsed.hour);
      const key = `${parsed.day}|${bucket}`;
      heatmap[key] = (heatmap[key] || 0) + 1;
    });
    const bestTimeToMessage = Object.entries(heatmap).map(([key, count]) => {
      const [day, bucket] = key.split('|');
      return { day, bucket, count };
    });

    res.json({ messageStepToBooking, ctaToBooking, responseRateByType, responseRateByGender, sentimentBreakdown, bestTimeToMessage, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Conversion intelligence error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Section 4's "Log a deal" - writes to the real Deals table (replaces the
// old speculative Sales Log write this route used to make).
app.post('/api/campaign/:id/deals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const campaignName = decodeURIComponent(req.params.id);
  const { contactId, companyId, outcome, dealValue, assigneeId, notes, date, sentiment } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  try {
    const campaignRecord = await findCampaignRecordByName(campaignName);
    const fields = {
      'Contact': [contactId],
      'Outcome': outcome || 'Pending',
      'Deal Value': dealValue || 0,
      'Notes': notes || '',
      'Date': date || new Date().toISOString().slice(0, 10)
    };
    if (companyId) fields['Company'] = [companyId];
    if (assigneeId) fields['Assignee'] = [assigneeId];
    if (sentiment) fields['Sentiment'] = sentiment;
    if (campaignRecord) fields['Campaign'] = [campaignRecord.id];
    const data = await airtableRequest('POST', 'Deals', { records: [{ fields }], typecast: true });
    res.json({ success: true, deal: data.records[0] });
  } catch (err) {
    console.error('Create deal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Inline-edit endpoint for the Sales Log table's Stage/Deal Value/Assignee cells.
app.patch('/api/campaign/:id/deals/:dealId', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { dealId } = req.params;
  const { outcome, dealValue, assigneeId } = req.body;
  try {
    const fields = {};
    if (outcome !== undefined) fields['Outcome'] = outcome;
    if (dealValue !== undefined) fields['Deal Value'] = dealValue;
    if (assigneeId !== undefined) fields['Assignee'] = assigneeId ? [assigneeId] : [];
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
    await airtableRequest('PATCH', 'Deals', { records: [{ id: dealId, fields }], typecast: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Update deal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The pre/post-meeting notes thread on an expanded Sales Log row. Appends
// to Deals.Notes (same append-log convention as Conversation Context),
// responds immediately, then kicks off a background AI Summary refresh on
// the linked Contact/Company so meeting intelligence never stays siloed
// inside the deal log.
app.post('/api/deals/:dealId/notes', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { dealId } = req.params;
  const { noteText, phase } = req.body;
  if (!noteText || !phase) return res.status(400).json({ error: 'noteText and phase are required' });
  try {
    const dealRecord = await airtableGetRecord('Deals', dealId);
    if (!dealRecord) return res.status(404).json({ error: 'Deal not found' });
    const phaseLabel = phase === 'pre' ? 'Pre-meeting' : 'Post-meeting';
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = `[${timestamp}] (${phaseLabel}) ${noteText}`;
    const existing = dealRecord.fields['Notes'] || '';
    const newNotes = existing ? existing + '\n\n' + line : line;
    await airtableRequest('PATCH', 'Deals', { records: [{ id: dealId, fields: { 'Notes': newNotes } }] });

    res.json({ success: true, notes: newNotes });

    const contactId = (dealRecord.fields['Contact'] || [])[0] || null;
    const companyId = (dealRecord.fields['Company'] || [])[0] || null;
    if (contactId || companyId) {
      refreshContactAndCompanySummaries(contactId, companyId, `${phaseLabel} note on a deal: ${noteText}`)
        .catch(err => console.warn('Background summary refresh error:', err.message));
    }
    detectContentSignals().catch(err => console.warn('Content signal detection trigger failed:', err.message));
  } catch (err) {
    console.error('Deal notes error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Reps CRUD - "Manage reps" modal on the Sales tab.
app.get('/api/reps', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const data = await airtableRequest('GET', 'Reps');
    res.json({ reps: (data.records || []).map(r => ({ id: r.id, name: r.fields['Name'] || '', email: r.fields['Email'] || '' })) });
  } catch (err) {
    console.error('List reps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reps', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const data = await airtableRequest('POST', 'Reps', {
      records: [{ fields: { 'Name': name, 'Email': email || '', 'Added Date': new Date().toISOString().slice(0, 10) } }]
    });
    const r = data.records[0];
    res.json({ success: true, rep: { id: r.id, name: r.fields['Name'] || '', email: r.fields['Email'] || '' } });
  } catch (err) {
    console.error('Create rep error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Airtable's delete endpoint takes record ids as query params, not a JSON
// body - airtableRequest always JSON-encodes body, so this is a bespoke
// fetch rather than a reuse of that helper.
app.delete('/api/reps/:repId', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const url = `${AIRTABLE_URL}/Reps?records[]=${encodeURIComponent(req.params.repId)}`;
    const resp = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
    if (!resp.ok) { const err = await resp.text(); throw new Error(`Airtable error ${resp.status}: ${err}`); }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete rep error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sales Calendar (top-level nav, not campaign-scoped) - meetings from Deals
// where Outcome is Pending or Started. ?assigneeId= narrows server-side,
// though the frontend mostly filters the already-fetched list client-side
// instead (rep counts are small, avoids a second network round trip).
app.get('/api/calendar/events', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const assigneeId = (req.query.assigneeId || '').trim();
  try {
    const [dealsData, remindersData, contactsData, companiesData, campaignsData, repsData] = await Promise.all([
      airtableRequest('GET', 'Deals'),
      airtableRequest('GET', 'Reminders'),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Campaigns'),
      airtableRequest('GET', 'Reps')
    ]);
    const contactsById = {}; (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });
    const companiesById = {}; (companiesData.records || []).forEach(r => { companiesById[r.id] = r; });
    const campaignsById = {}; (campaignsData.records || []).forEach(r => { campaignsById[r.id] = r; });
    const repsById = {}; (repsData.records || []).forEach(r => { repsById[r.id] = r; });

    let events = (dealsData.records || [])
      .filter(r => ['Pending', 'Started'].includes(r.fields['Outcome']))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const companyId = (r.fields['Company'] || [])[0] || null;
        const campaignRecId = (r.fields['Campaign'] || [])[0] || null;
        const assigneeRecId = (r.fields['Assignee'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        const company = companyId ? companiesById[companyId] : null;
        const camp = campaignRecId ? campaignsById[campaignRecId] : null;
        const rep = assigneeRecId ? repsById[assigneeRecId] : null;
        return {
          type: 'deal',
          dealId: r.id,
          date: r.fields['Date'] || '',
          contactName: contact ? (contact.fields['Full Name'] || '') : '',
          companyName: company ? (company.fields['Company Name'] || '') : '',
          campaignName: camp ? (camp.fields['Name'] || '') : '',
          stage: r.fields['Outcome'] || '',
          assigneeId: assigneeRecId,
          assigneeName: rep ? (rep.fields['Name'] || '') : '',
          notes: r.fields['Notes'] || ''
        };
      })
      .filter(ev => ev.date);

    const reminderEvents = (remindersData.records || [])
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const companyId = (r.fields['Company'] || [])[0] || null;
        const campaignRecId = (r.fields['Campaign'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        const company = companyId ? companiesById[companyId] : null;
        const camp = campaignRecId ? campaignsById[campaignRecId] : null;
        return {
          type: 'reminder',
          reminderId: r.id,
          date: r.fields['Due Date'] || '',
          description: r.fields['Description'] || '',
          contactName: contact ? (contact.fields['Full Name'] || '') : '',
          companyName: company ? (company.fields['Company Name'] || '') : '',
          campaignName: camp ? (camp.fields['Name'] || '') : ''
        };
      })
      .filter(ev => ev.date);

    if (assigneeId) events = events.filter(ev => ev.assigneeId === assigneeId);
    events = events.concat(reminderEvents);

    res.json({ events });
  } catch (err) {
    console.error('Calendar events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CONTENT SYSTEM =====================
// Data-driven content engine: watches touch points, DM screenshot parses,
// meeting notes, and logged company/contact signals for recurring themes,
// surfaces them as Content Signals, and drafts LinkedIn/Blog/Newsletter
// copy in Marcus's documented voice (Content Settings, the account-level
// singleton) informed by real account data. The Content/Content Settings/
// Content Signals tables already existed in the base before this feature -
// the Content table's old Content Type/Pain Point Tag/Scheduled Date/
// Linked Contacts/Delivery Rate (%) fields belong to a different, never-
// built legacy content feature and are never read or written by anything
// below - only the newer Body/Format/Target ICP/Campaign/Target Companies/
// Detected From Signal/Content Settings/Content Signals fields are used.

const CONTENT_TABLE = 'Content';
const CONTENT_SIGNALS_TABLE = 'Content Signals';
const CONTENT_SETTINGS_TABLE = 'Content Settings';

function daysAgoDate(n) {
  return new Date(Date.now() - n * 86400000);
}

// Deals.Notes and Content.Voice Notes both use the same append-log
// convention this app already established for Deals.Notes: "[YYYY-MM-DD
// HH:mm] (Label) text", blocks separated by a blank line. This parses just
// the date portion, which is all detectContentSignals needs for cutoff
// filtering.
function parseTimestampedBlocks(text) {
  if (!text) return [];
  return text.split('\n\n').map(block => {
    const m = block.match(/^\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*\(([^)]+)\)\s*([\s\S]*)$/);
    return m ? { date: m[1], label: m[2], text: m[3] } : null;
  }).filter(Boolean);
}

// Content Settings is a singleton - one row is the account-wide voice
// profile. Get-or-default: never creates a row itself, so every route that
// only *reads* the profile (draft, signals) degrades gracefully to "no
// profile yet" instead of silently creating empty rows. Only
// getOrCreateContentSettingsRecord() (used by the settings-save and
// cadence routes, the two legitimate write paths) creates one.
async function getContentSettingsRecord() {
  const data = await airtableRequest('GET', CONTENT_SETTINGS_TABLE);
  return (data.records && data.records[0]) || null;
}

async function getOrCreateContentSettingsRecord() {
  const existing = await getContentSettingsRecord();
  if (existing) return existing;
  const data = await airtableRequest('POST', CONTENT_SETTINGS_TABLE, { records: [{ fields: {} }] });
  return data.records[0];
}

// Word-count targets straight from the brief. Newsletter has no Length
// Preference field on Content Settings (unlike LinkedIn/Blog), so it gets
// one fixed target regardless of the (currently unused) lengthKey - guided
// instead by the free-text Newsletter Notes field in the prompt itself.
const CONTENT_LENGTH_TARGETS = {
  'LinkedIn Post': { Short: 'under 150 words', Medium: '150-300 words', Long: '300+ words' },
  'Blog': { Short: 'around 500 words', Medium: '800-1200 words', Long: '1500+ words' },
  'Newsletter': { Short: '400-600 words', Medium: '400-600 words', Long: '400-600 words' }
};

// Scans the last 30 days of Touch Points and Deals.Notes for recurring
// themes and writes any new, non-duplicate ones to Content Signals. Never
// throws - every trigger call site fires this unawaited after its own
// res.json(), and the explicit POST /api/content/detect-signals route
// awaits it purely to report a count, not to surface errors, so an
// internal failure here must never become a 500 for either caller.
async function detectContentSignals() {
  try {
    const cutoff = daysAgoDate(30);
    const recentCutoff = daysAgoDate(7);

    const [tpData, dealsData, contactsData, companiesData, existingSignalsData] = await Promise.all([
      airtableRequest('GET', 'Touch Points'),
      airtableRequest('GET', 'Deals'),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', CONTENT_SIGNALS_TABLE)
    ]);

    const contactsById = {};
    (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });
    const companiesById = {};
    (companiesData.records || []).forEach(r => { companiesById[r.id] = r; });

    const recentTouchPoints = (tpData.records || [])
      .filter(r => r.fields['Date'] && new Date(r.fields['Date']) >= cutoff)
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        const companyId = contact ? (contact.fields['Company'] || [])[0] || null : null;
        const company = companyId ? companiesById[companyId] : null;
        return {
          contactName: contact ? contact.fields['Full Name'] : null,
          companyName: company ? company.fields['Company Name'] : null,
          date: r.fields['Date'],
          summary: r.fields['Summary'] || ''
        };
      })
      .filter(tp => tp.summary && tp.contactName);

    const recentDealNotes = [];
    (dealsData.records || []).forEach(r => {
      const contactId = (r.fields['Contact'] || [])[0] || null;
      const companyId = (r.fields['Company'] || [])[0] || null;
      const contact = contactId ? contactsById[contactId] : null;
      const company = companyId ? companiesById[companyId] : null;
      parseTimestampedBlocks(r.fields['Notes']).forEach(block => {
        if (new Date(block.date) >= cutoff) {
          recentDealNotes.push({
            contactName: contact ? contact.fields['Full Name'] : null,
            companyName: company ? company.fields['Company Name'] : null,
            date: block.date,
            summary: block.text
          });
        }
      });
    });

    if (recentTouchPoints.length + recentDealNotes.length < 2) return { created: 0 };

    const recentSignalThemes = (existingSignalsData.records || [])
      .filter(r => r.fields['Detected Date'] && new Date(r.fields['Detected Date']) >= recentCutoff)
      .map(r => r.fields['Theme'] || '')
      .filter(Boolean);

    const prompt = `You are identifying recurring content themes for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM, from real logged activity over the last 30 days.

TOUCH POINTS (${recentTouchPoints.length}):
${JSON.stringify(recentTouchPoints, null, 2)}

DEAL NOTES (${recentDealNotes.length}):
${JSON.stringify(recentDealNotes, null, 2)}

THEMES ALREADY SURFACED IN THE LAST 7 DAYS (do not resurface these, even worded differently):
${JSON.stringify(recentSignalThemes)}

Identify recurring themes worth turning into content (a LinkedIn post, blog, or newsletter). A theme only qualifies if it is mentioned by at least 2 different contacts or companies (not the same person twice). For each qualifying theme, judge whether it is really the same idea as one already listed above (isDuplicateOfExisting) - only flag it true if you are confident it's a repeat.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "signals": [ { "theme": string, "frequency": number, "relatedContactNames": string[], "relatedCompanyNames": string[], "suggestedFormat": "LinkedIn Post"|"Blog"|"Newsletter", "suggestedIcpTargets": string, "isDuplicateOfExisting": boolean } ] }`;

    const parsed = await callClaudeJson(prompt, 1800);
    const candidates = (parsed.signals || []).filter(s => s.theme && s.frequency >= 2 && !s.isDuplicateOfExisting);
    if (!candidates.length) return { created: 0 };

    // Backstop substring dedup, in case the model's own judgement missed a
    // near-exact repeat of a recently-surfaced theme.
    const recentThemesNormalized = recentSignalThemes.map(t => t.toLowerCase().trim());
    const toWrite = candidates.filter(c => {
      const norm = c.theme.toLowerCase().trim();
      return !recentThemesNormalized.some(existing => existing.includes(norm) || norm.includes(existing));
    });
    if (!toWrite.length) return { created: 0 };

    const campaignContactRows = await fetchCampaignContactsRows();
    const contactsByName = {};
    (contactsData.records || []).forEach(r => { if (r.fields['Full Name']) contactsByName[r.fields['Full Name']] = r; });
    const companiesByName = {};
    (companiesData.records || []).forEach(r => { if (r.fields['Company Name']) companiesByName[r.fields['Company Name']] = r; });

    const today = new Date().toISOString().slice(0, 10);
    const records = toWrite.map(c => {
      const relatedContactRecords = (c.relatedContactNames || []).map(n => contactsByName[n]).filter(Boolean);
      const relatedCompanyRecords = (c.relatedCompanyNames || []).map(n => companiesByName[n]).filter(Boolean);

      // Campaign-tagging heuristic: only tag a signal to a campaign when
      // every related contact (directly, or via a related company's own
      // contacts) maps to exactly one campaign - otherwise it's an
      // account-wide signal and Campaign is left blank, shown only at the
      // top level and on Home.
      const campaignIds = new Set();
      const contactIdsInvolved = new Set(relatedContactRecords.map(r => r.id));
      relatedCompanyRecords.forEach(co => (co.fields['Contacts'] || []).forEach(cid => contactIdsInvolved.add(cid)));
      contactIdsInvolved.forEach(cid => {
        campaignContactRows
          .filter(row => (row.fields['Contact'] || []).includes(cid))
          .forEach(row => (row.fields['Campaign'] || []).forEach(campId => campaignIds.add(campId)));
      });

      const fields = {
        'Theme': c.theme,
        'Frequency': c.frequency,
        'Suggested Format': c.suggestedFormat || 'LinkedIn Post',
        'Suggested ICP Targets': c.suggestedIcpTargets || '',
        'Status': 'New',
        'Detected Date': today
      };
      if (relatedContactRecords.length) fields['Related Contacts'] = relatedContactRecords.map(r => r.id);
      if (relatedCompanyRecords.length) fields['Related Companies'] = relatedCompanyRecords.map(r => r.id);
      if (campaignIds.size === 1) fields['Campaign'] = [...campaignIds];
      return { fields };
    });

    for (let i = 0; i < records.length; i += 10) {
      await airtableRequest('POST', CONTENT_SIGNALS_TABLE, { records: records.slice(i, i + 10), typecast: true });
    }
    return { created: records.length };
  } catch (err) {
    console.warn('Content signal detection failed (non-fatal):', err.message);
    return { created: 0, error: err.message };
  }
}

// Manual/explicit trigger - awaits purely to report a count, since
// detectContentSignals() above never throws.
app.post('/api/content/detect-signals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const result = await detectContentSignals();
  res.json({ success: true, created: result.created });
});

app.get('/api/content/signals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const campaignName = (req.query.campaignName || '').trim();
  try {
    const [data, contactsData, companiesData, campaignRecord] = await Promise.all([
      airtableRequest('GET', CONTENT_SIGNALS_TABLE),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Companies'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);
    const contactsById = {}; (contactsData.records || []).forEach(r => { contactsById[r.id] = r.fields['Full Name'] || ''; });
    const companiesById = {}; (companiesData.records || []).forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });

    let records = (data.records || []).filter(r => (r.fields['Status'] || 'New') !== 'Dismissed');
    if (campaignName) records = records.filter(r => campaignRecord && (r.fields['Campaign'] || []).includes(campaignRecord.id));

    const signals = records
      .sort((a, b) => new Date(b.fields['Detected Date'] || 0) - new Date(a.fields['Detected Date'] || 0))
      .map(r => ({
        id: r.id,
        theme: r.fields['Theme'] || '',
        frequency: r.fields['Frequency'] || 0,
        relatedContactNames: (r.fields['Related Contacts'] || []).map(id => contactsById[id]).filter(Boolean),
        relatedCompanyNames: (r.fields['Related Companies'] || []).map(id => companiesById[id]).filter(Boolean),
        suggestedFormat: r.fields['Suggested Format'] || '',
        suggestedIcpTargets: r.fields['Suggested ICP Targets'] || '',
        status: r.fields['Status'] || 'New',
        detectedDate: r.fields['Detected Date'] || ''
      }));

    res.json({ signals });
  } catch (err) {
    console.error('List content signals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/content/signals/:id', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  try {
    await airtableRequest('PATCH', CONTENT_SIGNALS_TABLE, { records: [{ id: req.params.id, fields: { 'Status': status } }], typecast: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Update content signal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/drafts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { campaignName, format, status } = req.query;
  try {
    const [data, companiesData, campaignsData, campaignRecord] = await Promise.all([
      airtableRequest('GET', CONTENT_TABLE),
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Campaigns'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);
    const companiesById = {}; (companiesData.records || []).forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });
    const campaignsById = {}; (campaignsData.records || []).forEach(r => { campaignsById[r.id] = r.fields['Name'] || ''; });

    // Rows from the old, dead legacy content feature never have a Format
    // (they use the unrelated Content Type field instead) - filtering on
    // Format truthy is how this Draft Centre stays clear of them.
    let records = (data.records || []).filter(r => r.fields['Format']);
    if (campaignName) records = records.filter(r => campaignRecord && (r.fields['Campaign'] || []).includes(campaignRecord.id));
    if (format) records = records.filter(r => r.fields['Format'] === format);
    if (status) records = records.filter(r => r.fields['Status'] === status);

    const drafts = records
      .sort((a, b) => new Date(b.fields['Target Publish Date'] || 0) - new Date(a.fields['Target Publish Date'] || 0))
      .map(r => {
        const campId = (r.fields['Campaign'] || [])[0] || null;
        return {
          id: r.id,
          title: r.fields['Title'] || '',
          body: r.fields['Body'] || '',
          format: r.fields['Format'] || '',
          status: r.fields['Status'] || 'Draft',
          campaignId: campId,
          campaignName: campId ? (campaignsById[campId] || '') : '',
          targetIcp: r.fields['Target ICP'] || '',
          targetCompanyIds: r.fields['Target Companies'] || [],
          targetCompanyNames: (r.fields['Target Companies'] || []).map(id => companiesById[id]).filter(Boolean),
          voiceNotes: r.fields['Voice Notes'] || '',
          signalId: (r.fields['Detected From Signal'] || [])[0] || null,
          targetPublishDate: r.fields['Target Publish Date'] || ''
        };
      });

    res.json({ drafts });
  } catch (err) {
    console.error('List content drafts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/draft', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { format, lengthPreference, topic, signalId, campaignId, campaignName, campaignContentContext, mode, contentId, refineInstructions, setStatus, title, body, targetIcp } = req.body;
  const draftMode = mode || 'new';

  try {
    // Direct save, no Claude call - the editor's "Save changes" (title/body/
    // targetIcp) and "Mark as Ready" (setStatus) both use this, since
    // neither needs a re-draft.
    if (draftMode === 'save') {
      if (!contentId) return res.status(400).json({ error: 'contentId is required' });
      const fields = {};
      if (title !== undefined) fields['Title'] = title;
      if (body !== undefined) fields['Body'] = body;
      if (targetIcp !== undefined) fields['Target ICP'] = targetIcp;
      if (setStatus) fields['Status'] = setStatus;
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to save' });
      await airtableRequest('PATCH', CONTENT_TABLE, { records: [{ id: contentId, fields }], typecast: true });
      return res.json({ success: true, contentId, ...fields, status: fields['Status'] });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    if ((draftMode === 'regenerate' || draftMode === 'refine') && !contentId) {
      return res.status(400).json({ error: 'contentId is required for regenerate/refine' });
    }
    if (draftMode === 'refine' && !refineInstructions) {
      return res.status(400).json({ error: 'refineInstructions is required for refine' });
    }

    let existingContent = null;
    if (contentId) existingContent = await airtableGetRecord(CONTENT_TABLE, contentId);

    const resolvedFormat = format || (existingContent && existingContent.fields['Format']) || 'LinkedIn Post';
    const settings = await getContentSettingsRecord();
    const sf = settings ? settings.fields : {};

    let signalRecord = null;
    if (signalId) signalRecord = await airtableGetRecord(CONTENT_SIGNALS_TABLE, signalId);
    else if (existingContent && (existingContent.fields['Detected From Signal'] || [])[0]) {
      signalRecord = await airtableGetRecord(CONTENT_SIGNALS_TABLE, existingContent.fields['Detected From Signal'][0]);
    }

    let resolvedCampaignId = campaignId || (existingContent && (existingContent.fields['Campaign'] || [])[0]) || null;
    if (!resolvedCampaignId && campaignName) {
      const resolvedCampaign = await findCampaignRecordByName(campaignName);
      resolvedCampaignId = resolvedCampaign ? resolvedCampaign.id : null;
    }
    let contentContext = campaignContentContext;
    if (resolvedCampaignId && contentContext === undefined) {
      const campaignRecord = await airtableGetRecord('Campaigns', resolvedCampaignId);
      contentContext = campaignRecord ? (campaignRecord.fields['Content Context'] || '') : '';
    }

    const lengthKey = lengthPreference || (resolvedFormat === 'Blog' ? sf['Blog Length Preference'] : sf['LinkedIn Length Preference']) || 'Medium';
    const lengthTarget = (CONTENT_LENGTH_TARGETS[resolvedFormat] || CONTENT_LENGTH_TARGETS['LinkedIn Post'])[lengthKey] || CONTENT_LENGTH_TARGETS['LinkedIn Post'].Medium;
    const exampleText = resolvedFormat === 'Blog' ? (sf['Example Blogs'] || '') : (sf['Example Posts'] || '');

    const resolvedTopic = topic || (existingContent && existingContent.fields['Title']) || (signalRecord && signalRecord.fields['Theme']) || '';
    if (!resolvedTopic && draftMode === 'new') return res.status(400).json({ error: 'topic or signalId is required' });

    let targetCompanies = [];
    if (signalRecord) targetCompanies = signalRecord.fields['Related Companies'] || [];
    else if (existingContent) targetCompanies = existingContent.fields['Target Companies'] || [];

    const performancePatterns = draftMode !== 'refine' ? await getContentPerformanceSummaryForPrompt() : '';

    let prompt;
    if (draftMode === 'refine') {
      prompt = `You are Marcus, writing for T2C Outreach, Twenty2 Collective. You previously drafted this ${resolvedFormat}:

---
${existingContent.fields['Body'] || ''}
---

Refine it per this instruction: "${refineInstructions}"

Stay in the same voice and keep the same core message unless the instruction says otherwise. Target length: ${lengthTarget}.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "title": string, "body": string }`;
    } else {
      prompt = `You are Marcus, writing in first person for T2C Outreach, Twenty2 Collective, a Perth-based Agile and change consultancy.

VOICE PROFILE:
Writing style: ${sf['Voice Style'] || 'not documented yet - write in a natural, professional consultant voice'}
Tone: ${sf['Tone'] || 'Conversational'}
Topics to be known for: ${sf['Topics To Cover'] || 'not documented yet'}
Topics to avoid: ${sf['Topics To Avoid'] || 'none documented'}
${exampleText ? `Example ${resolvedFormat === 'Blog' ? 'blog excerpts' : 'LinkedIn posts'} to match the pattern of:\n${exampleText}` : ''}
${resolvedFormat === 'Newsletter' && sf['Newsletter Notes'] ? `Newsletter format notes: ${sf['Newsletter Notes']}` : ''}
${contentContext ? `\nCAMPAIGN CONTENT CONTEXT (reshapes but does not override the voice profile above):\n${contentContext}` : ''}

TOPIC: ${resolvedTopic}
${signalRecord ? `This is informed by a real recurring theme detected from account activity: "${signalRecord.fields['Theme'] || ''}". Suggested ICP targets: ${signalRecord.fields['Suggested ICP Targets'] || 'not specified'}.` : ''}
${performancePatterns ? `\nWHAT HAS PERFORMED WELL BEFORE (Marcus's own top posts by engagement - use these patterns, don't copy them):\n${performancePatterns}` : ''}

Write a ${resolvedFormat} of target length ${lengthTarget}. UK English, no em dashes, first person as Marcus.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "title": string, "body": string }`;
    }

    const drafted = await callClaudeJson(prompt, 3500);

    if (draftMode === 'new') {
      const fields = {
        'Title': drafted.title || resolvedTopic,
        'Body': drafted.body || '',
        'Format': resolvedFormat,
        'Target ICP': (signalRecord && signalRecord.fields['Suggested ICP Targets']) || '',
        'Status': 'Draft'
      };
      if (settings) fields['Content Settings'] = [settings.id];
      if (resolvedCampaignId) fields['Campaign'] = [resolvedCampaignId];
      if (targetCompanies.length) fields['Target Companies'] = targetCompanies;
      if (signalId) {
        // Written defensively on both link fields - unclear from the
        // schema alone whether either auto-mirrors the other.
        fields['Detected From Signal'] = [signalId];
        fields['Content Signals'] = [signalId];
      }

      const data = await airtableRequest('POST', CONTENT_TABLE, { records: [{ fields }], typecast: true });
      const record = data.records[0];

      if (signalId) {
        airtableRequest('PATCH', CONTENT_SIGNALS_TABLE, { records: [{ id: signalId, fields: { 'Status': 'Actioned' } }] })
          .catch(err => console.warn('Could not mark content signal Actioned:', err.message));
      }

      return res.json({ success: true, contentId: record.id, title: fields['Title'], body: fields['Body'], format: resolvedFormat, targetIcp: fields['Target ICP'], status: 'Draft' });
    }

    // regenerate / refine
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const logLine = draftMode === 'refine'
      ? `[${timestamp}] (Refine) Refine with instructions: "${refineInstructions}"`
      : `[${timestamp}] (Regenerate) Regenerated using the same brief`;
    const existingVoiceNotes = existingContent.fields['Voice Notes'] || '';
    const updateFields = {
      'Body': drafted.body || '',
      'Voice Notes': existingVoiceNotes ? existingVoiceNotes + '\n\n' + logLine : logLine
    };
    if (drafted.title) updateFields['Title'] = drafted.title;
    if (setStatus) updateFields['Status'] = setStatus;

    await airtableRequest('PATCH', CONTENT_TABLE, { records: [{ id: contentId, fields: updateFields }], typecast: true });
    res.json({
      success: true,
      contentId,
      title: updateFields['Title'] || existingContent.fields['Title'],
      body: updateFields['Body'],
      format: resolvedFormat,
      status: setStatus || existingContent.fields['Status']
    });
  } catch (err) {
    console.error('Content draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/settings', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const record = await getContentSettingsRecord();
    const f = record ? record.fields : {};
    res.json({
      voiceStyle: f['Voice Style'] || '',
      tone: f['Tone'] || '',
      topicsToCover: f['Topics To Cover'] || '',
      topicsToAvoid: f['Topics To Avoid'] || '',
      examplePosts: f['Example Posts'] || '',
      exampleBlogs: f['Example Blogs'] || '',
      linkedinLengthPreference: f['LinkedIn Length Preference'] || '',
      blogLengthPreference: f['Blog Length Preference'] || '',
      newsletterNotes: f['Newsletter Notes'] || '',
      recommendedCadence: f['Recommended Cadence'] || ''
    });
  } catch (err) {
    console.error('Get content settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/settings', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { voiceStyle, tone, topicsToCover, topicsToAvoid, examplePosts, exampleBlogs, linkedinLengthPreference, blogLengthPreference, newsletterNotes } = req.body;
  try {
    const record = await getOrCreateContentSettingsRecord();
    await airtableRequest('PATCH', CONTENT_SETTINGS_TABLE, {
      records: [{
        id: record.id,
        fields: {
          'Voice Style': voiceStyle || '',
          'Tone': tone || '',
          'Topics To Cover': topicsToCover || '',
          'Topics To Avoid': topicsToAvoid || '',
          'Example Posts': examplePosts || '',
          'Example Blogs': exampleBlogs || '',
          'LinkedIn Length Preference': linkedinLengthPreference || '',
          'Blog Length Preference': blogLengthPreference || '',
          'Newsletter Notes': newsletterNotes || ''
        }
      }],
      typecast: true
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Save content settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/cadence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const [campaigns, contactsData] = await Promise.all([fetchCampaigns(), airtableRequest('GET', 'Contacts')]);
    const activeCampaigns = campaigns.filter(c => c.status === 'Live');
    const prompt = `T2C Outreach has ${activeCampaigns.length} active (Live) campaign(s) out of ${campaigns.length} total, and ${(contactsData.records || []).length} contacts in the pipeline.

Active campaigns: ${activeCampaigns.map(c => c.name).join(', ') || 'none'}.

Recommend a realistic content posting cadence across LinkedIn, Blog, and Newsletter for one person (Marcus) to sustain. Return ONLY the recommendation as a single sentence, in this exact style: "Based on your active campaigns and contact pipeline, we suggest 2 LinkedIn posts per week, 1 blog per month, 1 newsletter per month." Nothing else.`;
    const cadence = await callClaudeText(prompt, 150);
    const record = await getOrCreateContentSettingsRecord();
    await airtableRequest('PATCH', CONTENT_SETTINGS_TABLE, { records: [{ id: record.id, fields: { 'Recommended Cadence': cadence } }] });
    res.json({ success: true, cadence });
  } catch (err) {
    console.error('Content cadence error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== TRIGIFY INTEGRATION =====================
// Contact post monitoring (Part 1), Serper-based job-title drift detection
// (Part 2), and Marcus's own content performance analysis (Part 3). The
// Settings table (singleton, like Content Settings) holds the Trigify
// Marcus search id plus "My LinkedIn URL" - the brief called this
// "Marcus's LinkedIn URL from Content Settings", but the field actually
// lives on the real Settings table, so that's what's read here.
//
// Trigify's LinkedIn monitoring API (per its API docs) only has one
// profile-monitor endpoint, and it tracks exactly one profile per search:
//   POST /v1/searches/linkedin/profile  { name, profile_url, max_results?,
//     frequency?: DAILY|WEEKLY|MONTHLY|QUARTERLY,
//     time_frame?: past-24h|past-week|past-month|past-year|all-time }
//   GET  /v1/searches/{id}/results
// There is no multi-profile search - a contact-wide monitor isn't
// possible, so Contacts gets one Trigify search each (Contacts.Trigify
// Search ID), same as Marcus's own search (Settings.Trigify Marcus Search
// ID). All calls are funnelled through trigifyRequest().

const TRIGIFY_API_KEY = process.env.TRIGIFY_API_KEY;
const TRIGIFY_URL = 'https://api.trigify.io';
const TRIGIFY_MARCUS_SEARCH_NAME = 'T2C — Marcus Content';
const SETTINGS_TABLE = 'Settings';
const CONTENT_PERFORMANCE_TABLE = 'Content Performance';

async function trigifyRequest(method, path, body) {
  const res = await fetch(`${TRIGIFY_URL}${path}`, {
    method,
    headers: {
      'x-api-key': TRIGIFY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const errBody = await res.text();
    const trigifyErr = new Error(`Trigify error ${res.status}: ${errBody}`);
    trigifyErr.status = res.status;
    trigifyErr.body = errBody;
    throw trigifyErr;
  }
  return res.json();
}

// Settings is a singleton, same convention as getContentSettingsRecord.
async function getSettingsRecord() {
  const data = await airtableRequest('GET', SETTINGS_TABLE);
  return (data.records && data.records[0]) || null;
}

async function getOrCreateSettingsRecord() {
  const existing = await getSettingsRecord();
  if (existing) return existing;
  const data = await airtableRequest('POST', SETTINGS_TABLE, { records: [{ fields: {} }] });
  return data.records[0];
}

// Called from the Settings page's LinkedIn accounts save/add/delete flow
// (see saveLinkedInAccounts() in t2c-outreach-crm.html) to keep the
// account marked Primary (or the first account, if none is marked) mirrored
// to Settings.My LinkedIn URL - the field the Trigify Marcus content search
// (trigifyEnsureMarcusSearch, below) reads from.
app.post('/api/settings/linkedin-url', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { url } = req.body;
  try {
    const settingsRecord = await getOrCreateSettingsRecord();
    await airtableRequest('PATCH', SETTINGS_TABLE, {
      records: [{ id: settingsRecord.id, fields: { 'My LinkedIn URL': url || '' } }]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Save primary LinkedIn URL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One profile per search - the only shape POST /v1/searches/linkedin/
// profile supports. Returns the new search id.
// Trigify expects a full LinkedIn profile URL - contacts are sometimes
// saved with just a slug or path (e.g. "jane-doe" or "in/jane-doe")
// rather than the full https://www.linkedin.com/in/... URL, which Trigify
// rejects. Leaves anything already on the linkedin.com domain untouched.
function normalizeLinkedInUrl(url) {
  if (!url) return url;
  let trimmed = url.trim();
  // Regional LinkedIn subdomains (au., uk., my., ca., or any other
  // two-letter country code) are the same site as far as Trigify is
  // concerned - it only accepts www.linkedin.com.
  trimmed = trimmed.replace(/^https:\/\/[a-z]{2}\.linkedin\.com/i, 'https://www.linkedin.com');
  if (trimmed.startsWith('https://www.linkedin.com')) return trimmed;
  const slug = trimmed.replace(/^\/?(in\/)?/i, '');
  return `https://www.linkedin.com/in/${slug}`;
}

async function trigifyCreateProfileMonitor(name, profileUrl, { maxResults, frequency, timeFrame } = {}) {
  const payload = { name, profile_url: normalizeLinkedInUrl(profileUrl) };
  if (maxResults) payload.max_results = maxResults;
  if (frequency) payload.frequency = frequency;
  if (timeFrame) payload.time_frame = timeFrame;
  const result = await trigifyRequest('POST', '/v1/searches/linkedin/profile', payload);
  const searchId = result.id || (result.search && result.search.id);
  if (!searchId) throw new Error('Trigify did not return a search id');
  return searchId;
}

// Fire-and-forget creation of one new contact's own Trigify profile
// monitor, called from POST /api/airtable/contact right after a new
// contact is created. No-ops quietly if Trigify isn't configured - the
// contact save itself must never fail because of this.
async function trigifyCreateContactSearch(contactId, contactName, linkedinUrl) {
  if (!TRIGIFY_API_KEY || !AIRTABLE_API_KEY) return;
  const searchId = await trigifyCreateProfileMonitor(`T2C — ${contactName}`, linkedinUrl, { maxResults: 10, frequency: 'DAILY' });
  await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'Trigify Search ID': searchId } }] });
}

function normalizeTrigifyPost(p) {
  const reactions = p.reactions;
  const engagement = p.engagement;
  return {
    text: p.text || p.content || p.body || '',
    date: p.date || p.collected_at || p.collectedAt || p.published_at || p.publishedAt || p.postedAt || p.createdAt || p.created_at || '',
    likes: p.likes
      ?? p.likeCount
      ?? p.like_count
      ?? (typeof reactions === 'number' ? reactions : reactions?.likes)
      ?? engagement?.likes
      ?? 0,
    comments: p.comments
      ?? p.commentCount
      ?? p.comment_count
      ?? p.comments_count
      ?? engagement?.comments
      ?? 0
  };
}

// Each search now tracks exactly one known profile (the contact or Marcus,
// already resolved by whoever called trigifyGetSearchResults), so results
// no longer need per-profile grouping/matching - just a flat post list.
// Handles both a flat array of posts and one grouped under posts/items,
// since the exact results shape isn't specified beyond the endpoint path.
function normalizeTrigifyResults(rawResults) {
  const posts = [];
  (rawResults || []).forEach(raw => {
    if (Array.isArray(raw.posts) || Array.isArray(raw.items)) {
      (raw.posts || raw.items).forEach(p => posts.push(normalizeTrigifyPost(p)));
    } else {
      posts.push(normalizeTrigifyPost(raw));
    }
  });
  return posts;
}

async function trigifyGetSearchResults(searchId) {
  const data = await trigifyRequest('GET', `/v1/searches/${searchId}/results`);
  return data.results || data.data || [];
}

function formatRecentPosts(posts) {
  return posts.map(p => {
    const date = p.date ? new Date(p.date).toISOString().slice(0, 10) : '';
    const text = (p.text || '').replace(/\s+/g, ' ').trim();
    return `[${date}] ${text} | Likes: ${p.likes ?? 0} Comments: ${p.comments ?? 0}`;
  }).join('\n\n');
}

// One Claude call per contact covering all of their (up to 3) fetched
// posts together, rather than one call per individual post - cheaper and
// no less accurate, since a job change only needs to be caught once.
async function detectJobChangeFromPosts(posts) {
  if (!posts.length || !process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `Below are up to 3 recent LinkedIn posts from one person, newest first. Determine if ANY of them signal a job change - language like "excited to join", "starting as", "leaving", "new role", "new chapter" (or similar). If so, extract the new company and/or role and the post's date.

POSTS:
${JSON.stringify(posts.map(p => ({ date: p.date, text: p.text })))}

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "isJobChange": boolean, "newCompanyOrRole": string, "date": string }`;
  try {
    const parsed = await callClaudeJson(prompt, 500);
    return parsed && parsed.isJobChange ? parsed : null;
  } catch (err) {
    console.warn('Job change detection failed for a contact (non-fatal):', err.message);
    return null;
  }
}

// Shared by the manual POST route and the daily 6am cron job below - never
// throws for a single bad contact/result, since one malformed Trigify
// result shouldn't sink the whole sync. Iterates every Contact that has
// its own Trigify Search ID (set by /api/trigify/setup-contact-search or
// on contact creation), one results fetch per contact - there's no more
// shared multi-profile search to fetch once and match against.
async function syncTrigifyContactPosts() {
  const contacts = await airtableFetchAllRecords('Contacts');
  const targets = contacts.filter(c => c.fields['Trigify Search ID']);
  if (!targets.length) return { synced: 0, message: 'No contacts have a Trigify Search ID yet - run setup-contact-search first' };

  const updates = [];
  for (const contact of targets) {
    let posts;
    try {
      posts = normalizeTrigifyResults(await trigifyGetSearchResults(contact.fields['Trigify Search ID']));
    } catch (err) {
      console.warn(`Trigify results fetch failed for ${contact.fields['Full Name']} (non-fatal):`, err.message);
      continue;
    }
    if (!posts.length) continue;

    const top3 = posts.slice(0, 3);
    const fields = { 'Recent Posts': formatRecentPosts(top3) };

    const jobChange = await detectJobChangeFromPosts(top3);
    if (jobChange) {
      fields['Job Change Signal'] = `${jobChange.newCompanyOrRole || 'Possible job change'}${jobChange.date ? ' — ' + jobChange.date : ''}`;
    }
    updates.push({ id: contact.id, fields });
  }

  for (let i = 0; i < updates.length; i += 10) {
    await airtableRequest('PATCH', 'Contacts', { records: updates.slice(i, i + 10), typecast: true });
  }
  return { synced: updates.length, checked: targets.length };
}

// Creates one Trigify profile monitor per contact that has a LinkedIn URL
// but no Trigify Search ID yet (contacts already set up - e.g. by the
// on-create hook above - are skipped, so re-running this only fills in the
// gaps instead of re-creating every search each time).
app.post('/api/trigify/setup-contact-search', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!TRIGIFY_API_KEY) return res.status(500).json({ error: 'TRIGIFY_API_KEY not configured' });

  try {
    const contacts = await airtableFetchAllRecords('Contacts');
    const alreadySetUp = contacts.filter(c => c.fields['Trigify Search ID']).length;
    const targets = contacts.filter(c => c.fields['LinkedIn URL'] && !c.fields['Trigify Search ID']);

    let created = 0;
    const errors = [];
    for (const contact of targets) {
      try {
        const searchId = await trigifyCreateProfileMonitor(
          `T2C — ${contact.fields['Full Name']}`,
          contact.fields['LinkedIn URL'],
          { maxResults: 10, frequency: 'WEEKLY' }
        );
        await airtableRequest('PATCH', 'Contacts', { records: [{ id: contact.id, fields: { 'Trigify Search ID': searchId } }] });
        created++;
      } catch (err) {
        errors.push(`${contact.fields['Full Name']}: ${err.message}`);
      }
    }

    res.json({ success: true, created, alreadySetUp, errors });
  } catch (err) {
    console.error('Trigify setup-contact-search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-time backfill for contacts found before automatic Trigify
// registration existed on contact creation (POST /api/airtable/contact) -
// registers everyone with a LinkedIn URL but no Trigify Search ID yet via
// the same trigifyCreateContactSearch() that on-create hook uses, so
// there's one registration implementation instead of two.
app.get('/api/trigify/backfill-contacts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!TRIGIFY_API_KEY) return res.status(500).json({ error: 'TRIGIFY_API_KEY not configured' });

  try {
    const contacts = await airtableFetchAllRecords('Contacts');
    const targets = contacts.filter(c => c.fields['LinkedIn URL'] && !c.fields['Trigify Search ID']);
    console.log(`Trigify backfill: ${targets.length} contact(s) need a Trigify search out of ${contacts.length} total.`);

    let registered = 0;
    const errors = [];
    for (let i = 0; i < targets.length; i++) {
      const contact = targets[i];
      const name = contact.fields['Full Name'] || contact.id;
      const normalizedUrl = normalizeLinkedInUrl(contact.fields['LinkedIn URL']);
      try {
        await trigifyCreateContactSearch(contact.id, name, normalizedUrl);
        registered++;
        console.log(`Trigify backfill (${i + 1}/${targets.length}): registered ${name}`);
      } catch (err) {
        // Trigify 409s "This profile is already being monitored" when a
        // search for this profile already exists (e.g. from an earlier,
        // partially-failed backfill run) - look up the existing search id
        // instead of leaving the contact unregistered, same fallback
        // trigifyEnsureMarcusSearch uses for Marcus's own search.
        if (err.status === 409 && /already being monitored/i.test(err.body || '')) {
          try {
            const existingId = await trigifyFindExistingSearch(normalizedUrl, `T2C — ${name}`);
            if (existingId) {
              await airtableRequest('PATCH', 'Contacts', { records: [{ id: contact.id, fields: { 'Trigify Search ID': existingId } }] });
              registered++;
              console.log(`Trigify backfill (${i + 1}/${targets.length}): already monitored, linked existing search for ${name}`);
            } else {
              errors.push(`${name}: already monitored, but no matching search was found in GET /v1/searches`);
              console.warn(`Trigify backfill (${i + 1}/${targets.length}): already monitored but no matching search found for ${name}`);
            }
          } catch (lookupErr) {
            errors.push(`${name}: ${lookupErr.message}`);
            console.warn(`Trigify backfill (${i + 1}/${targets.length}): failed to look up existing search for ${name} - ${lookupErr.message}`);
          }
        } else {
          errors.push(`${name}: ${err.message}`);
          console.warn(`Trigify backfill (${i + 1}/${targets.length}): failed for ${name} - ${err.message}`);
        }
      }
    }

    console.log(`Trigify backfill complete: ${registered} registered, ${errors.length} failed.`);
    res.json({ success: true, checked: contacts.length, targeted: targets.length, registered, errors });
  } catch (err) {
    console.error('Trigify backfill-contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigify/sync-contact-posts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!TRIGIFY_API_KEY) return res.status(500).json({ error: 'TRIGIFY_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const result = await syncTrigifyContactPosts();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Trigify sync-contact-posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Part 2: Serper job title drift detection ----

// Pulls the headline/title portion out of a Google result title for a
// LinkedIn profile, e.g. "Jane Doe - Head of Marketing - Acme | LinkedIn"
// -> "Head of Marketing - Acme". Falls back to the raw snippet by the
// caller if this can't confidently strip the name.
function extractHeadlineFromSerpTitle(title, fullName) {
  if (!title) return '';
  let rest = title;
  if (fullName && rest.toLowerCase().indexOf(fullName.toLowerCase()) === 0) {
    rest = rest.slice(fullName.length);
  }
  rest = rest.replace(/^[\s\-|]+/, '');
  rest = rest.split(' | ')[0];
  return rest.trim();
}

// Shared by the manual POST route and the Sunday 7am cron job below.
async function checkContactJobChanges() {
  const [contacts, companiesData] = await Promise.all([
    airtableFetchAllRecords('Contacts'),
    airtableRequest('GET', 'Companies')
  ]);
  const companiesById = {};
  (companiesData.records || []).forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });

  const targets = contacts.filter(c => c.fields['LinkedIn URL'] && c.fields['Job Title']);
  const updates = [];

  for (const contact of targets) {
    const name = contact.fields['Full Name'];
    const companyId = (contact.fields['Company'] || [])[0];
    const companyName = companyId ? companiesById[companyId] : '';
    if (!companyName) continue;

    try {
      const serperRes = await fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `"${name}" "${companyName}" site:linkedin.com` })
      });
      if (!serperRes.ok) continue;
      const data = await serperRes.json();
      const top = (data.organic || [])[0];
      if (!top) continue;

      const headline = extractHeadlineFromSerpTitle(top.title, name) || top.snippet || '';
      const storedTitle = (contact.fields['Job Title'] || '').toLowerCase().trim();
      if (!headline || !storedTitle) continue;

      const headlineLower = headline.toLowerCase();
      const sameTitle = headlineLower.includes(storedTitle) || storedTitle.includes(headlineLower);
      if (sameTitle) continue;
      if (contact.fields['Job Change Signal']) continue;

      updates.push({ id: contact.id, fields: { 'Job Change Signal': `Serper detected possible title change: ${headline} — verify manually` } });
    } catch (err) {
      console.warn(`Job change check failed for ${name}:`, err.message);
    }
  }

  for (let i = 0; i < updates.length; i += 10) {
    await airtableRequest('PATCH', 'Contacts', { records: updates.slice(i, i + 10), typecast: true });
  }
  return { checked: targets.length, flagged: updates.length };
}

app.post('/api/contacts/check-job-changes', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });
  try {
    const result = await checkContactJobChanges();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Check job changes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Part 3: Marcus's content performance analysis ----

// Looks up an existing Trigify search by profile URL or name - used when
// creating a search 409s because the profile is already monitored (e.g.
// a leftover search from a previous run/account) instead of a new
// Trigify Marcus Search ID ever getting saved.
async function trigifyFindExistingSearch(profileUrl, name) {
  const data = await trigifyRequest('GET', '/v1/searches');
  const list = data.searches || data.data || data.results || [];
  const match = list.find(s => (s.profile_url && s.profile_url === profileUrl) || (s.name && s.name === name));
  return match ? (match.id || (match.search && match.search.id)) : null;
}

async function trigifyEnsureMarcusSearch() {
  const settingsRecord = await getOrCreateSettingsRecord();
  const marcusUrl = settingsRecord.fields['My LinkedIn URL'];
  if (!marcusUrl) throw new Error("Marcus's LinkedIn URL is not set in Settings yet");

  let searchId = settingsRecord.fields['Trigify Marcus Search ID'] || null;
  if (searchId) return searchId;

  try {
    // 3 months isn't a single time_frame option - past-month is the closest
    // supported value, and the search re-runs weekly regardless.
    searchId = await trigifyCreateProfileMonitor(TRIGIFY_MARCUS_SEARCH_NAME, marcusUrl, {
      maxResults: 25,
      frequency: 'WEEKLY',
      timeFrame: 'past-month'
    });
  } catch (err) {
    // Trigify 409s "This profile is already being monitored" when a search
    // for this profile already exists - look it up instead of failing.
    if (err.status === 409 && /already being monitored/i.test(err.body || '')) {
      searchId = await trigifyFindExistingSearch(marcusUrl, TRIGIFY_MARCUS_SEARCH_NAME);
      if (!searchId) throw new Error('Trigify reported this profile is already monitored, but no matching search was found in GET /v1/searches');
    } else {
      throw err;
    }
  }

  await airtableRequest('PATCH', SETTINGS_TABLE, {
    records: [{ id: settingsRecord.id, fields: { 'Trigify Marcus Search ID': searchId } }]
  });
  return searchId;
}

// Reads the last few highest-engagement Content Performance rows, formatted
// for inclusion in a content draft prompt. Called from POST /api/content/
// draft below so new drafts are informed by what has actually worked.
// Never throws - a missing/empty table just means no patterns to add yet.
async function getContentPerformanceSummaryForPrompt() {
  try {
    const records = await airtableFetchAllRecords(CONTENT_PERFORMANCE_TABLE);
    if (!records.length) return '';
    const top = records
      .slice()
      .sort((a, b) => (b.fields['Engagement Score'] || 0) - (a.fields['Engagement Score'] || 0))
      .slice(0, 8);
    return top.map(r => `- Topic: ${r.fields['Topic'] || '—'} | Format: ${r.fields['Format'] || '—'} | Engagement: ${r.fields['Engagement Score'] || 0} | What worked: ${r.fields['What Worked'] || '—'}`).join('\n');
  } catch (err) {
    console.warn('Could not load content performance for draft prompt (non-fatal):', err.message);
    return '';
  }
}

// In-memory status for the background job below - single job at a time
// (there's only one Marcus), overwritten on every new run. Not persisted:
// a server restart mid-run just drops back to idle, which is fine since
// the saved-so-far records are already durably in Airtable regardless.
let marcusAnalysisJob = { status: 'idle', savedCount: 0, error: null, startedAt: null, finishedAt: null };

// Does the actual Trigify fetch + Claude scoring + Airtable writes, kicked
// off fire-and-forget by the POST route below so it keeps running even if
// the frontend that triggered it navigates away or disconnects. Updates
// marcusAnalysisJob as it goes so GET /api/trigify/marcus-content-status
// can report live progress to the My Performance tab's poll.
async function runMarcusContentAnalysisJob(forceRefresh = false) {
  try {
    if (!forceRefresh) {
      const existing = await airtableFetchAllRecords(CONTENT_PERFORMANCE_TABLE);
      if (existing.length) {
        marcusAnalysisJob = { status: 'complete', savedCount: existing.length, error: null, startedAt: marcusAnalysisJob.startedAt, finishedAt: Date.now() };
        return;
      }
    }

    let searchId, rawResults;
    try {
      searchId = await trigifyEnsureMarcusSearch();
      rawResults = await trigifyGetSearchResults(searchId);
      console.log('Marcus content analysis - Trigify fetch complete. searchId:', searchId, 'raw result count:', Array.isArray(rawResults) ? rawResults.length : typeof rawResults);

      const sampleContainer = (rawResults || [])[0];
      const sampleRawPost = sampleContainer && (Array.isArray(sampleContainer.posts) || Array.isArray(sampleContainer.items))
        ? (sampleContainer.posts || sampleContainer.items)[0]
        : sampleContainer;
      console.log('Marcus content analysis - raw Trigify post object for one post (exact fields as returned by Trigify):', JSON.stringify(sampleRawPost, null, 2));
    } catch (err) {
      console.error('Marcus content analysis - Trigify fetch failed:', err.message);
      throw err;
    }

    let posts;
    try {
      posts = normalizeTrigifyResults(rawResults);
      console.log('Marcus content analysis - extracted post text. post count:', posts.length, 'sample post:', JSON.stringify(posts[0]));
    } catch (err) {
      console.error('Marcus content analysis - extracting post text failed:', err.message);
      throw err;
    }

    if (!posts.length) {
      marcusAnalysisJob = { status: 'complete', savedCount: 0, error: null, startedAt: marcusAnalysisJob.startedAt, finishedAt: Date.now(), message: 'No posts found in the past month' };
      return;
    }

    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      batches.push(posts.slice(i, i + BATCH_SIZE));
    }

    let analysed = [];
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const batchLabel = `batch ${b + 1}/${batches.length}`;

      const prompt = `You are analysing Marcus's own LinkedIn posts from the past month for T2C Outreach, Twenty2 Collective, to learn what content performs well.

POSTS (${batch.length}):
${JSON.stringify(batch)}

For EACH post, analyse and return: post_text, date, likes, comments, engagement_score (likes + comments), topic (3-5 words describing what the post is about), format (one of: short, long, question, story, insight), cta_used (the call to action used, or empty string if none), what_worked (one sentence on why this post performed well or didn't).

Return each post as an object with keys: post_text, date, likes, comments, engagement_score, topic, format, cta_used, what_worked.

Respond with only a valid JSON array. No preamble, no explanation, no markdown formatting. Start your response with [ and end with ].`;

      let rawText;
      try {
        console.log(`Marcus content analysis - calling Claude for ${batchLabel}. prompt length:`, prompt.length, 'post count:', batch.length);
        rawText = await callClaudeText(prompt, 4000);
        console.log(`Marcus content analysis - raw Claude text for ${batchLabel}:`, rawText);
      } catch (err) {
        console.error(`Marcus content analysis - Claude call failed for ${batchLabel}:`, err.message);
        throw err;
      }

      const stripped = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const arrayMatch = stripped.match(/\[[\s\S]*\]/);
      let batchAnalysed;
      try {
        batchAnalysed = JSON.parse(arrayMatch ? arrayMatch[0] : stripped);
      } catch (parseErr) {
        console.error(`Marcus content analysis - JSON parse failed for ${batchLabel}. stripped text:`, stripped);
        throw new Error('Could not parse Claude response as JSON');
      }
      if (!Array.isArray(batchAnalysed)) batchAnalysed = [];

      console.log(`Marcus content analysis - sample parsed object for ${batchLabel}:`, JSON.stringify(batchAnalysed[0]));
      analysed = analysed.concat(batchAnalysed);
    }

    const fieldsForPost = p => ({
      'Post Text': p.post_text || '',
      'Date': p.date || '',
      'Likes': p.likes || 0,
      'Comments': p.comments || 0,
      'Engagement Score': p.engagement_score ?? ((p.likes || 0) + (p.comments || 0)),
      'Topic': p.topic || '',
      'Format': p.format || '',
      'CTA Used': p.cta_used || '',
      'What Worked': p.what_worked || '',
      'Source': 'Trigify'
    });

    // Upsert by Post Text so re-running the analysis (or a forceRefresh)
    // updates already-saved posts instead of duplicating them - matched in
    // memory against a fresh fetch rather than findRecordByFieldName's
    // filterByFormula, since post text routinely contains quotes/newlines
    // that would break that formula.
    const existingByText = new Map(
      (await airtableFetchAllRecords(CONTENT_PERFORMANCE_TABLE)).map(r => [r.fields['Post Text'] || '', r.id])
    );

    const toUpdate = [];
    const toCreate = [];
    analysed.forEach(p => {
      const fields = fieldsForPost(p);
      const existingId = existingByText.get(fields['Post Text']);
      if (existingId) toUpdate.push({ id: existingId, fields });
      else toCreate.push({ fields });
    });

    for (let i = 0; i < toUpdate.length; i += 10) {
      await airtableRequest('PATCH', CONTENT_PERFORMANCE_TABLE, { records: toUpdate.slice(i, i + 10), typecast: true });
      marcusAnalysisJob.savedCount = Math.min(i + 10, toUpdate.length);
    }
    for (let i = 0; i < toCreate.length; i += 10) {
      await airtableRequest('POST', CONTENT_PERFORMANCE_TABLE, { records: toCreate.slice(i, i + 10), typecast: true });
      marcusAnalysisJob.savedCount = toUpdate.length + Math.min(i + 10, toCreate.length);
    }

    marcusAnalysisJob = { status: 'complete', savedCount: toUpdate.length + toCreate.length, error: null, startedAt: marcusAnalysisJob.startedAt, finishedAt: Date.now() };
  } catch (err) {
    console.error('Marcus content analysis job failed:', err.message);
    marcusAnalysisJob = { status: 'error', savedCount: marcusAnalysisJob.savedCount, error: err.message, startedAt: marcusAnalysisJob.startedAt, finishedAt: Date.now() };
  }
}

// Fire-and-forget: responds immediately so the frontend button isn't stuck
// waiting on a request that can take minutes, then keeps running server-
// side regardless of whether that request is still connected.
app.post('/api/trigify/marcus-content-analysis', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!TRIGIFY_API_KEY) return res.status(500).json({ error: 'TRIGIFY_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  if (marcusAnalysisJob.status === 'running') {
    return res.json({ success: true, alreadyRunning: true, message: 'Analysis already running, results will appear in Airtable shortly.' });
  }

  const forceRefresh = req.body?.forceRefresh === true;
  marcusAnalysisJob = { status: 'running', savedCount: 0, error: null, startedAt: Date.now(), finishedAt: null };
  runMarcusContentAnalysisJob(forceRefresh);

  res.json({ success: true, message: 'Analysis started, results will appear in Airtable shortly.' });
});

app.get('/api/trigify/marcus-content-status', (req, res) => {
  res.json({
    status: marcusAnalysisJob.status,
    savedCount: marcusAnalysisJob.savedCount,
    error: marcusAnalysisJob.error,
    startedAt: marcusAnalysisJob.startedAt,
    finishedAt: marcusAnalysisJob.finishedAt
  });
});

app.get('/api/content/performance', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const records = await airtableFetchAllRecords(CONTENT_PERFORMANCE_TABLE);
    const posts = records.map(r => ({
      id: r.id,
      postText: r.fields['Post Text'] || '',
      date: r.fields['Date'] || '',
      likes: r.fields['Likes'] || 0,
      comments: r.fields['Comments'] || 0,
      engagementScore: r.fields['Engagement Score'] || 0,
      topic: r.fields['Topic'] || '',
      format: r.fields['Format'] || '',
      ctaUsed: r.fields['CTA Used'] || '',
      whatWorked: r.fields['What Worked'] || ''
    })).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json({ posts });
  } catch (err) {
    console.error('Get content performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== PROFILE DRAWERS (contacts + companies) =====================
// Backs the slide-out profile drawer opened from a Grid contact/company
// name. Contact/company lookups use findRecordByFieldName (name-based,
// filterByFormula) - the same convention every other Contacts/Companies
// route in this file already uses, not the more robust
// findCampaignRecordByName fetch-all-and-match pattern (that fix was
// Campaigns-specific). A name containing a double quote would fail to
// resolve here, same as it already would everywhere else in this file.

// Reminders created from note-extracted actions are a separate table from
// Deals, specifically so a "follow up next Wednesday" nudge never counts
// toward the Sales tab's pipeline funnel/scorecards.

app.get('/api/contacts/profile', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const name = (req.query.name || '').trim();
  const campaignName = (req.query.campaignName || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const cf = contactRecord.fields || {};

    const [companiesData, campaignsData, ccRows, tpData, dealsData, campaignRecord] = await Promise.all([
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Campaigns'),
      fetchCampaignContactsRows(),
      airtableRequest('GET', 'Touch Points'),
      airtableRequest('GET', 'Deals'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);

    const companiesById = {}; (companiesData.records || []).forEach(r => { companiesById[r.id] = r; });
    const campaignsById = {}; (campaignsData.records || []).forEach(r => { campaignsById[r.id] = r; });

    const companyId = (cf['Company'] || [])[0] || null;
    const company = companyId ? companiesById[companyId] : null;

    const myCcRows = ccRows.filter(r => (r.fields['Contact'] || []).includes(contactRecord.id));
    const campaigns = myCcRows
      .map(r => {
        const campId = (r.fields['Campaign'] || [])[0];
        return campId && campaignsById[campId] ? { id: campId, name: campaignsById[campId].fields['Name'] || '' } : null;
      })
      .filter(Boolean);

    let sequenceStage = null;
    if (campaignRecord) {
      const row = myCcRows.find(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
      if (row) sequenceStage = row.fields['Sequence Stage'] || '';
    }

    let touchPoints = (tpData.records || [])
      .filter(r => (r.fields['Contact'] || []).includes(contactRecord.id))
      .map(r => {
        const campId = (r.fields['Campaign'] || [])[0] || null;
        const tpCampaignName = campId && campaignsById[campId] ? (campaignsById[campId].fields['Name'] || '') : '';
        return { date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '', campaignName: tpCampaignName, relevantToCurrentCampaign: null };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Campaign relevance judgement - only when opened from within a
    // campaign and there are touch points logged under a different one.
    if (campaignRecord) {
      const otherIndexes = [];
      touchPoints.forEach((tp, i) => { if (tp.campaignName && tp.campaignName !== campaignName) otherIndexes.push(i); });
      if (otherIndexes.length) {
        try {
          const cRec = campaignRecord.fields || {};
          const prompt = `You are judging touch point relevance for a CRM. Current campaign context:
Goal: ${cRec['Goal'] || ''}
Target ICP: ${cRec['Target ICP'] || ''}
Strategy notes: ${cRec['Strategy Notes'] || ''}

For each of these touch points logged with this same contact under OTHER campaigns, judge whether it discussed the same ICP pain points or products as the current campaign (making it worth surfacing here too), or is genuinely unrelated.

Touch points:
${JSON.stringify(otherIndexes.map(i => ({ index: i, notes: touchPoints[i].notes, campaignName: touchPoints[i].campaignName })), null, 2)}

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "results": [{ "index": number, "relevant": boolean }] }`;
          const parsed = await callClaudeJson(prompt, 800);
          const relevanceByIndex = {};
          (parsed.results || []).forEach(r => { relevanceByIndex[r.index] = !!r.relevant; });
          touchPoints = touchPoints.map((tp, i) => otherIndexes.includes(i) ? Object.assign({}, tp, { relevantToCurrentCampaign: relevanceByIndex[i] || false }) : tp);
        } catch (relErr) {
          console.warn('Campaign relevance judgement failed (non-fatal):', relErr.message);
        }
      }
    }

    const deals = (dealsData.records || [])
      .filter(r => (r.fields['Contact'] || []).includes(contactRecord.id))
      .map(r => {
        const campId = (r.fields['Campaign'] || [])[0] || null;
        return {
          id: r.id,
          outcome: r.fields['Outcome'] || '',
          dealValue: r.fields['Deal Value'] || 0,
          date: r.fields['Date'] || '',
          notes: r.fields['Notes'] || '',
          campaignName: campId && campaignsById[campId] ? (campaignsById[campId].fields['Name'] || '') : ''
        };
      });

    const firstContactedDate = touchPoints.length ? touchPoints[touchPoints.length - 1].date : null;
    const enrichMatch = (cf['AI Summary'] || '').match(/^\[Enriched:\s*(\d{4}-\d{2}-\d{2})\]/);

    res.json({
      contact: {
        id: contactRecord.id,
        fullName: cf['Full Name'] || '',
        jobTitle: cf['Job Title'] || '',
        companyName: company ? (company.fields['Company Name'] || '') : '',
        companyId,
        linkedinUrl: cf['LinkedIn URL'] || '',
        journeyStage: cf['Journey Stage'] || '',
        aiSummary: cf['AI Summary'] || '',
        notes: cf['Notes'] || '',
        lastEnrichedDate: enrichMatch ? enrichMatch[1] : null
      },
      sequenceStage,
      campaigns,
      touchPoints,
      deals,
      firstContactedDate
    });
  } catch (err) {
    console.error('Contact profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/enrich', async (req, res) => {
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name, company } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const slug = extractLinkedInSlug(contactRecord.fields['LinkedIn URL'] || '');

    const [profileSearch, newsSearch] = await Promise.all([
      fetch(SERPER_URL, { method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: slug ? `site:linkedin.com/in/${slug}` : `${name} LinkedIn` }) }).then(r => r.json()),
      fetch(SERPER_URL, { method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: `${name} ${company || ''}`.trim() }) }).then(r => r.json())
    ]);
    const profileResults = (profileSearch.organic || []).slice(0, 5).map(r => `${r.title || ''}\n${r.snippet || ''}`).join('\n\n');
    const newsResults = (newsSearch.organic || []).slice(0, 5).map(r => `${r.title || ''}\n${r.snippet || ''}\n${r.link || ''}`).join('\n\n');

    const prompt = `You are researching a LinkedIn contact for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM, ahead of outreach.

Contact: ${name}${company ? ' at ' + company : ''}.

LinkedIn search results:
${profileResults || 'No results found.'}

General/news search results for "${name} ${company || ''}":
${newsResults || 'No results found.'}

Based only on the above, return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "headline": string, "bioSummary": string, "recentPosts": [{"summary": string}], "newsMentions": string[], "yearsInRole": string, "previousCompanies": string[] }

"recentPosts" should have at most 3 entries, each a one-or-two sentence summary of a real post if findable, empty array if none found. If a field can't be determined from the results, say "Not enough public information found" rather than inventing detail.`;

    const enrichment = await callClaudeJson(prompt, 1200);
    const today = new Date().toISOString().slice(0, 10);
    const formattedBlock = [
      `[Enriched: ${today}]`,
      `Headline: ${enrichment.headline || '—'}`,
      `Bio: ${enrichment.bioSummary || '—'}`,
      (enrichment.recentPosts || []).length ? `Recent posts:\n${enrichment.recentPosts.map(p => `- ${p.summary}`).join('\n')}` : '',
      (enrichment.newsMentions || []).length ? `News mentions:\n${enrichment.newsMentions.map(n => `- ${n}`).join('\n')}` : '',
      `Years in current role: ${enrichment.yearsInRole || '—'}`,
      (enrichment.previousCompanies || []).length ? `Previous companies: ${enrichment.previousCompanies.join(', ')}` : ''
    ].filter(Boolean).join('\n');

    const existingSummary = contactRecord.fields['AI Summary'] || '';
    const newSummary = existingSummary ? formattedBlock + '\n\n' + existingSummary : formattedBlock;
    await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactRecord.id, fields: { 'AI Summary': newSummary } }] });

    res.json(Object.assign({ success: true, enrichedDate: today }, enrichment));
  } catch (err) {
    console.error('Contact enrich error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/notes', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name, noteText } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const dateLabel = new Date().toISOString().slice(0, 10);
    const existing = contactRecord.fields['Notes'] || '';
    const line = `[${dateLabel}] ${noteText}`;
    const newNotes = existing ? existing + '\n\n' + line : line;
    await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactRecord.id, fields: { 'Notes': newNotes } }] });
    res.json({ success: true, notes: newNotes });
  } catch (err) {
    console.error('Contact notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/update-summary', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { name, noteText } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    await refreshContactAndCompanySummaries(contactRecord.id, null, noteText);
    res.json({ success: true });
  } catch (err) {
    console.error('Contact update-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/extract-actions', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { name, noteText, campaignName } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const campaignRecord = campaignName ? await findCampaignRecordByName(campaignName) : null;

    const today = new Date();
    const todayLabel = today.toISOString().slice(0, 10);
    const dayName = today.toLocaleDateString('en-AU', { weekday: 'long' });

    const prompt = `Today is ${dayName}, ${todayLabel}. Read this note about a CRM contact and identify any time-based follow-up actions or reminders mentioned (e.g. "contact next Wednesday", "follow up in two weeks", "call Thursday morning"). Resolve relative dates against today's date.

Note: "${noteText}"

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "actions": [{ "description": string, "dueDate": "YYYY-MM-DD" }] }

Return an empty array if there are no time-based actions in the note - do not invent one.`;

    const parsed = await callClaudeJson(prompt, 500);
    const actionsFound = parsed.actions || [];
    const createdDate = todayLabel;

    const created = [];
    for (const action of actionsFound) {
      if (!action.description || !action.dueDate) continue;
      const fields = { 'Description': action.description, 'Due Date': action.dueDate, 'Contact': [contactRecord.id], 'Source Note': noteText, 'Created Date': createdDate };
      if (campaignRecord) fields['Campaign'] = [campaignRecord.id];
      const data = await airtableRequest('POST', 'Reminders', { records: [{ fields }] });
      created.push({ reminderId: data.records[0].id, description: action.description, dueDate: action.dueDate });
    }

    res.json({ success: true, actions: created });
  } catch (err) {
    console.error('Contact extract-actions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reminders/:id', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const url = `${AIRTABLE_URL}/Reminders?records[]=${encodeURIComponent(req.params.id)}`;
    const resp = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
    if (!resp.ok) { const err = await resp.text(); throw new Error(`Airtable error ${resp.status}: ${err}`); }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete reminder error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companies/profile', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const companyRecord = await findRecordByFieldName('Companies', 'Company Name', name);
    if (!companyRecord) return res.status(404).json({ error: 'Company not found' });
    const cf = companyRecord.fields || {};

    const [contactsData, tpData, dealsData, signalsData] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      airtableRequest('GET', 'Deals'),
      airtableRequest('GET', 'Content Signals')
    ]);

    const myContactIds = new Set(cf['Contacts'] || []);
    const contactsById = {}; (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });

    const keyContacts = (contactsData.records || [])
      .filter(r => myContactIds.has(r.id))
      .map(r => ({ id: r.id, name: r.fields['Full Name'] || '', journeyStage: r.fields['Journey Stage'] || '' }));

    const touchPoints = (tpData.records || [])
      .filter(r => (r.fields['Contact'] || []).some(cid => myContactIds.has(cid)))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        return { date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '', contactName: contact ? (contact.fields['Full Name'] || '') : '' };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const deals = (dealsData.records || [])
      .filter(r => (r.fields['Company'] || []).includes(companyRecord.id))
      .map(r => ({ id: r.id, outcome: r.fields['Outcome'] || '', dealValue: r.fields['Deal Value'] || 0, date: r.fields['Date'] || '', notes: r.fields['Notes'] || '' }));

    const contentSignals = (signalsData.records || [])
      .filter(r => (r.fields['Related Companies'] || []).includes(companyRecord.id))
      .map(r => ({ id: r.id, theme: r.fields['Theme'] || '', detectedDate: r.fields['Detected Date'] || '' }));

    const enrichMatch = (cf['AI Summary'] || '').match(/^\[Enriched:\s*(\d{4}-\d{2}-\d{2})\]/);

    res.json({
      company: {
        id: companyRecord.id,
        name: cf['Company Name'] || '',
        industry: cf['Industry'] || '',
        sector: cf['Sector'] || '',
        linkedinUrl: cf['Company LinkedIn URL'] || '',
        aiSummary: cf['AI Summary'] || '',
        notes: cf['Notes'] || '',
        latestSignal: cf['Latest Signal'] || '',
        signalDate: cf['Signal Date'] || '',
        lastEnrichedDate: enrichMatch ? enrichMatch[1] : null
      },
      keyContacts,
      touchPoints,
      deals,
      contentSignals
    });
  } catch (err) {
    console.error('Company profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/enrich', async (req, res) => {
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const companyRecord = await findRecordByFieldName('Companies', 'Company Name', name);
    if (!companyRecord) return res.status(404).json({ error: 'Company not found' });

    const [linkedinSearch, newsSearch] = await Promise.all([
      fetch(SERPER_URL, { method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: `${name} site:linkedin.com/company/` }) }).then(r => r.json()),
      fetch(SERPER_URL, { method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: `${name} news` }) }).then(r => r.json())
    ]);
    const linkedinResults = (linkedinSearch.organic || []).slice(0, 5).map(r => `${r.title || ''}\n${r.snippet || ''}`).join('\n\n');
    const newsResults = (newsSearch.organic || []).slice(0, 5).map(r => `${r.title || ''}\n${r.snippet || ''}\n${r.link || ''}`).join('\n\n');

    const prompt = `You are researching a company for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM, ahead of outreach.

Company: ${name}

LinkedIn search results:
${linkedinResults || 'No results found.'}

News search results:
${newsResults || 'No results found.'}

Based only on the above, return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "industry": string, "estimatedSize": string, "linkedinSignalSummary": string, "recentNews": string[], "techStack": string[] }

If a field can't be determined from the results, say "Not enough public information found" rather than inventing detail.`;

    const enrichment = await callClaudeJson(prompt, 1000);
    const today = new Date().toISOString().slice(0, 10);
    const formattedBlock = [
      `[Enriched: ${today}]`,
      `Industry: ${enrichment.industry || '—'}`,
      `Estimated size: ${enrichment.estimatedSize || '—'}`,
      `LinkedIn signal: ${enrichment.linkedinSignalSummary || '—'}`,
      (enrichment.recentNews || []).length ? `Recent news:\n${enrichment.recentNews.map(n => `- ${n}`).join('\n')}` : '',
      (enrichment.techStack || []).length ? `Tech stack: ${enrichment.techStack.join(', ')}` : ''
    ].filter(Boolean).join('\n');

    const existingSummary = companyRecord.fields['AI Summary'] || '';
    const newSummary = existingSummary ? formattedBlock + '\n\n' + existingSummary : formattedBlock;
    await airtableRequest('PATCH', 'Companies', { records: [{ id: companyRecord.id, fields: { 'AI Summary': newSummary } }] });

    res.json(Object.assign({ success: true, enrichedDate: today }, enrichment));
  } catch (err) {
    console.error('Company enrich error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/notes', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name, noteText } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const companyRecord = await findRecordByFieldName('Companies', 'Company Name', name);
    if (!companyRecord) return res.status(404).json({ error: 'Company not found' });
    const dateLabel = new Date().toISOString().slice(0, 10);
    const existing = companyRecord.fields['Notes'] || '';
    const line = `[${dateLabel}] ${noteText}`;
    const newNotes = existing ? existing + '\n\n' + line : line;
    await airtableRequest('PATCH', 'Companies', { records: [{ id: companyRecord.id, fields: { 'Notes': newNotes } }] });
    res.json({ success: true, notes: newNotes });
  } catch (err) {
    console.error('Company notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/update-summary', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { name, noteText } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const companyRecord = await findRecordByFieldName('Companies', 'Company Name', name);
    if (!companyRecord) return res.status(404).json({ error: 'Company not found' });
    await refreshContactAndCompanySummaries(null, companyRecord.id, noteText);
    res.json({ success: true });
  } catch (err) {
    console.error('Company update-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/extract-actions', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { name, noteText, campaignName } = req.body;
  if (!name || !noteText) return res.status(400).json({ error: 'name and noteText are required' });
  try {
    const companyRecord = await findRecordByFieldName('Companies', 'Company Name', name);
    if (!companyRecord) return res.status(404).json({ error: 'Company not found' });
    const campaignRecord = campaignName ? await findCampaignRecordByName(campaignName) : null;

    const today = new Date();
    const todayLabel = today.toISOString().slice(0, 10);
    const dayName = today.toLocaleDateString('en-AU', { weekday: 'long' });

    const prompt = `Today is ${dayName}, ${todayLabel}. Read this note about a CRM company account and identify any time-based follow-up actions or reminders mentioned (e.g. "check back next Wednesday", "follow up in two weeks"). Resolve relative dates against today's date.

Note: "${noteText}"

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "actions": [{ "description": string, "dueDate": "YYYY-MM-DD" }] }

Return an empty array if there are no time-based actions in the note - do not invent one.`;

    const parsed = await callClaudeJson(prompt, 500);
    const actionsFound = parsed.actions || [];
    const createdDate = todayLabel;

    const created = [];
    for (const action of actionsFound) {
      if (!action.description || !action.dueDate) continue;
      const fields = { 'Description': action.description, 'Due Date': action.dueDate, 'Company': [companyRecord.id], 'Source Note': noteText, 'Created Date': createdDate };
      if (campaignRecord) fields['Campaign'] = [campaignRecord.id];
      const data = await airtableRequest('POST', 'Reminders', { records: [{ fields }] });
      created.push({ reminderId: data.records[0].id, description: action.description, dueDate: action.dueDate });
    }

    res.json({ success: true, actions: created });
  } catch (err) {
    console.error('Company extract-actions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CONTEXT TAB =====================
// Marcus's primary data input hub. Fields referenced below that don't exist
// yet on Contacts/Companies need to be created in Airtable (unconfirmed
// exact names, following this app's existing naming style):
//   Contacts: "AI Summary" (long text), "Conversation Context" (long text).
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
// driving Dashboard prioritisation exactly as before and stays on the
// Contact record, account-level.
//
// Sequence Stage used to live as a single select directly on Contacts, one
// global value per contact. It's now tracked per campaign instead, on the
// "Campaign Contacts" junction table (Contact link, Campaign link, Sequence
// Stage, Next Message Draft, Added Date) - one row per contact per
// campaign, so the same person can be at "Message 2 Sent" in one campaign
// and "Ready for Message 3" in another. The old "Sequence Stage" and "Next
// Message Draft" fields still exist on Contacts with whatever historical
// data they hold - nothing already there was deleted - but nothing in this
// file reads or writes them any more. The one exception carried over
// unchanged is the Connection Requested -> Connected transition: LinkedIn
// connection status is a fact about the person, not the campaign, so it
// still syncs across every Campaign Contacts row for that contact (see
// PATCH /api/context/contact-fields below) rather than being campaign-
// specific like every later stage.

const CAMPAIGN_CONTACTS_TABLE = 'Campaign Contacts';

// Fetches the whole Campaign Contacts table, same "fetch everything, filter
// in memory" approach already used for Touch Points/Contacts elsewhere in
// this file - filterByFormula doesn't reliably support matching linked-
// record cells by record id. Table may not exist in every base yet, so
// failures are swallowed like the Learning Data/Sales Log tables.
async function fetchCampaignContactsRows() {
  try {
    const data = await airtableRequest('GET', CAMPAIGN_CONTACTS_TABLE);
    return data.records || [];
  } catch (err) {
    console.warn('Could not fetch Campaign Contacts (table may not exist yet):', err.message);
    return [];
  }
}

function findCampaignContactRow(rows, contactId, campaignRecordId) {
  return rows.find(r => (r.fields['Contact'] || []).includes(contactId) && (r.fields['Campaign'] || []).includes(campaignRecordId));
}

// Looks for an existing junction row for this (contact, campaign) pair in
// the already-fetched `rows`, creating one at the default first stage
// ("Found") if none exists yet.
async function getOrCreateCampaignContactRow(contactId, contactName, campaignRecordId, campaignName, rows) {
  const existing = findCampaignContactRow(rows, contactId, campaignRecordId);
  if (existing) return existing;
  const addedDate = new Date().toISOString().slice(0, 10);
  const data = await airtableRequest('POST', CAMPAIGN_CONTACTS_TABLE, {
    records: [{
      fields: {
        'Name': `${contactName} — ${campaignName}`,
        'Contact': [contactId],
        'Campaign': [campaignRecordId],
        'Sequence Stage': 'Found',
        'Stage History': appendStageHistory('', 'Found', addedDate),
        'Added Date': addedDate
      }
    }]
  });
  return data.records[0];
}

// Sequence Stage vocabulary was simplified to a single linear flow for the
// Today's Actions fast-action cards: Found -> Connection Pending ->
// Message 1 Sent -> Message 2 Sent -> Message 3 Sent. Older rows (or ones
// still written by the DM-screenshot reply-tracking flow) may carry the
// previous "Connection Requested"/"Connected" labels - normalise those to
// the new ones wherever Sequence Stage is read, so both old and new rows
// drive the same card.
function normalizeSequenceStage(stage) {
  if (stage === 'Connection Requested') return 'Found';
  if (stage === 'Connected') return 'Connection Pending';
  return stage || 'Found';
}

// Straight-line advance for the Today's Actions "Copy & mark sent" flow -
// no reply-gating (no "Pending Reply"/"Ready for Message N" in between),
// unlike the DM-screenshot flow's SEQUENCE_STAGE_ADVANCE. Message 3 Sent
// is terminal: no further fast-action card shows for that contact.
const SEQUENCE_STAGE_NEXT = {
  'Found': 'Connection Pending',
  'Connection Pending': 'Message 1 Sent',
  'Message 1 Sent': 'Message 2 Sent',
  'Message 2 Sent': 'Message 3 Sent'
};

// Which message number a "Generate message" click should draft, given the
// contact's current (normalised) Sequence Stage.
const MESSAGE_NUMBER_FOR_STAGE = {
  'Connection Pending': 1,
  'Message 1 Sent': 2,
  'Message 2 Sent': 3
};

// Airtable caps batch writes at 10 records per request.
async function airtableBatchPatch(table, records) {
  for (let i = 0; i < records.length; i += 10) {
    await airtableRequest('PATCH', table, { records: records.slice(i, i + 10) });
  }
}

// Called when contacts are added to a campaign in the app - via the Grid
// tab (linking or creating a grid) or the Roadmap tab's "Add contacts"
// modal - so every contact in a campaign has a Campaign Contacts row from
// the moment they join it, not just once something happens to them there.
// Matches contacts by Full Name, same convention as every other route in
// this file that's given a name instead of an Airtable record id.
app.post('/api/campaign/:id/contacts/link', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const { contactNames } = req.body;
  if (!Array.isArray(contactNames) || !contactNames.length) return res.status(400).json({ error: 'contactNames is required' });

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.json({ success: false, reason: 'Campaign not found in Airtable' });

    const rows = await fetchCampaignContactsRows();
    let linked = 0, alreadyLinked = 0, notFound = 0;

    for (const name of contactNames) {
      const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
      if (!contactRecord) { notFound++; continue; }
      if (findCampaignContactRow(rows, contactRecord.id, campaignRecord.id)) { alreadyLinked++; continue; }
      const created = await getOrCreateCampaignContactRow(contactRecord.id, name, campaignRecord.id, campaignName, rows);
      rows.push(created);
      linked++;
    }

    res.json({ success: true, linked, alreadyLinked, notFound });
  } catch (err) {
    console.error('Campaign contacts link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Feeds the campaign Roadmap tab's per-card Sequence Stage badge - the
// Roadmap's kanban columns themselves stay driven by the app's own local
// pipeline state (unrelated to Airtable), but the Sequence Stage shown on
// each card is read live from Campaign Contacts, filtered to this campaign,
// which is the actual source of truth for that value now.
app.get('/api/campaign/:id/campaign-contacts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.json({ rows: [] });

    const [rows, contactsData] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableRequest('GET', 'Contacts')
    ]);
    const nameById = {};
    (contactsData.records || []).forEach(r => { nameById[r.id] = r.fields['Full Name'] || ''; });

    const result = rows
      .filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        return {
          campaignContactId: r.id,
          contactId,
          contactName: contactId ? (nameById[contactId] || '') : '',
          sequenceStage: normalizeSequenceStage(r.fields['Sequence Stage']),
          nextMessageDraft: r.fields['Next Message Draft'] || ''
        };
      })
      .filter(r => r.contactName);

    res.json({ rows: result });
  } catch (err) {
    console.error('Campaign contacts fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Drafts the next outreach message for a contact's Today's Actions "fast
// action" card, scoped to their specific campaign - not the account-level
// template/voice-profile flow used elsewhere (openGenerateModal), which
// has no concept of an individual campaign's goal/strategy. Only valid
// once the contact has actually been asked to connect (Connection Pending
// or later); "Found" gets a "Send connection" action instead, handled by
// the existing PATCH /api/context/contact-fields.
app.post('/api/campaign/:id/contacts/:contactId/generate-message', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const cf = contactRecord.fields || {};

    const rows = await fetchCampaignContactsRows();
    const row = await getOrCreateCampaignContactRow(contactId, cf['Full Name'] || contactId, campaignRecord.id, campaignName, rows);
    const stage = normalizeSequenceStage(row.fields['Sequence Stage']);
    const messageNumber = MESSAGE_NUMBER_FOR_STAGE[stage];
    if (!messageNumber) {
      return res.status(400).json({ error: `Contact is at Sequence Stage "${stage}" - not a stage this card generates a message for.` });
    }

    const camp = campaignRecord.fields || {};
    const prompt = `You are drafting LinkedIn outreach message ${messageNumber} of 3 for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Campaign: "${campaignName}". Goal: ${camp['Goal'] || 'not recorded'}. Product: ${camp['Product'] || 'not recorded'}. Target ICP: ${camp['Target ICP'] || 'not recorded'}. Strategy notes: ${camp['Strategy Notes'] || 'none recorded'}.

Contact: ${cf['Full Name'] || 'Unknown'}, ${cf['Job Title'] || ''}. AI summary: ${cf['AI Summary'] || 'none yet'}. Conversation so far: ${cf['Conversation Context'] || 'none yet - this is the first message'}.

Write only message ${messageNumber} in this contact's sequence for this specific campaign, following on naturally from the conversation so far (if any). UK English, no em dashes, peer to peer tone, 3-4 sentences, signed off "Marcus". Return only the message text, no preamble.`;

    const message = await callClaudeText(prompt, 400);
    await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, { records: [{ id: row.id, fields: { 'Next Message Draft': message } }] });

    res.json({ success: true, message, messageNumber, stage });
  } catch (err) {
    console.error('Generate message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Copy & mark sent" on a Today's Actions fast-action card: logs the sent
// message as a Touch Point tagged to this contact and campaign, advances
// Sequence Stage to the next stage in the linear Found -> Connection
// Pending -> Message 1/2/3 Sent flow (no reply-gating - unlike the DM-
// screenshot flow, there's no "Pending Reply"/"Ready for Message N" step
// in between), and clears the now-stale drafted message.
app.post('/api/campaign/:id/contacts/:contactId/mark-sent', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });

    const rows = await fetchCampaignContactsRows();
    const row = await getOrCreateCampaignContactRow(contactId, (contactRecord.fields || {})['Full Name'] || contactId, campaignRecord.id, campaignName, rows);
    const stage = normalizeSequenceStage(row.fields['Sequence Stage']);
    const nextStage = SEQUENCE_STAGE_NEXT[stage];
    if (!nextStage) {
      return res.status(400).json({ error: `Contact is already at the final stage ("${stage}") - nothing further to advance to.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, {
      records: [{
        id: row.id,
        fields: {
          'Sequence Stage': nextStage,
          'Stage History': appendStageHistory(row.fields['Stage History'], nextStage, today),
          'Next Message Draft': ''
        }
      }],
      typecast: true
    });

    await airtableRequest('POST', 'Touch Points', {
      records: [{
        fields: {
          'Date': today,
          'Type': 'LinkedIn Message',
          'Direction': 'Outbound',
          'Summary': message,
          'Contact': [contactId],
          'Campaign': [campaignRecord.id]
        }
      }],
      typecast: true
    });

    res.json({ success: true, newStage: nextStage });
  } catch (err) {
    console.error('Mark sent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/context/data - not one of the five endpoints named in the brief,
// but necessary supporting infrastructure: the Company dropdown and
// per-company Contact multi-select in the Touch Point Logger have nothing
// to populate from without it, and there was no existing route that
// returns Companies at all (only create/update-linkedin routes existed).
// campaignName (optional query param) scopes sequenceStage/nextMessageDraft
// to that campaign's Campaign Contacts row per contact - omit it (as the
// untagged top-level Context tab does) and both come back blank, since
// Sequence Stage no longer has a single global value to show. hasPending
// Connection is always computed account-wide regardless of campaignName,
// since the Connection Requested -> Connected transition is shared across
// every campaign a contact is in (see the note above the CONTEXT TAB
// section) - it's what the LinkedIn Connections CSV upload uses to decide
// who's eligible to advance.
app.get('/api/context/data', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = (req.query.campaignName || '').trim();

  try {
    const [companiesData, contactsData, touchPointsData, campaignContactRows, campaignRecord] = await Promise.all([
      airtableRequest('GET', 'Companies'),
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchCampaignContactsRows(),
      campaignName ? findRecordByFieldName('Campaigns', 'Name', campaignName) : Promise.resolve(null)
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

    const campaignRowsByContact = {};
    campaignContactRows.forEach(r => {
      (r.fields['Contact'] || []).forEach(cid => {
        if (!campaignRowsByContact[cid]) campaignRowsByContact[cid] = [];
        campaignRowsByContact[cid].push(r);
      });
    });

    const contacts = (contactsData.records || [])
      .map(r => {
        const companyIds = r.fields['Company'] || [];
        const recentTouchPoints = (touchPointsByContact[r.id] || [])
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 3);

        const myCampaignRows = campaignRowsByContact[r.id] || [];
        const hasPendingConnection = myCampaignRows.some(cr => ['Connection Requested', 'Found'].includes(cr.fields['Sequence Stage'] || ''));
        let sequenceStage = '', nextMessageDraft = '', campaignContactId = null;
        if (campaignRecord) {
          const myRow = myCampaignRows.find(cr => (cr.fields['Campaign'] || []).includes(campaignRecord.id));
          if (myRow) {
            sequenceStage = normalizeSequenceStage(myRow.fields['Sequence Stage']);
            nextMessageDraft = myRow.fields['Next Message Draft'] || '';
            campaignContactId = myRow.id;
          }
        }

        return {
          id: r.id,
          name: r.fields['Full Name'] || '',
          companyId: companyIds[0] || null,
          role: r.fields['Job Title'] || '',
          journeyStage: r.fields['Journey Stage'] || '',
          sequenceStage,
          campaignContactId,
          hasPendingConnection,
          aiSummary: r.fields['AI Summary'] || '',
          conversationContext: r.fields['Conversation Context'] || '',
          nextMessageDraft,
          recentTouchPoints
        };
      })
      .filter(c => c.name);

    res.json({ companies, contacts, campaignScoped: !!campaignRecord });
  } catch (err) {
    console.error('Context data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/context/contact-fields - also not one of the five named
// endpoints, but the LinkedIn Connections CSV card needs to write Journey
// Stage by record id, and the existing PATCH /api/airtable/contact/stage
// route works by name search and maps a found/opened/connected/messaging/
// booked app-state enum to Journey Stage rather than accepting it directly
// - reusing it would have meant overloading it with a second, unrelated
// update shape.
//
// sequenceStage='Connected' is the one remaining piece of Sequence Stage
// this route touches, and it no longer writes to Contacts at all - it
// syncs every one of this contact's Campaign Contacts rows that's still
// sitting at "Connection Requested" forward to "Connected", since accepting
// a LinkedIn connection is true for every campaign the contact is in, not
// just one. Rows already further along in a given campaign are left alone.
app.patch('/api/context/contact-fields', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactId, journeyStage, sequenceStage } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!journeyStage && sequenceStage !== 'Connection Pending') {
    return res.status(400).json({ error: 'journeyStage is required, or sequenceStage must be "Connection Pending"' });
  }

  try {
    if (journeyStage) {
      await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'Journey Stage': journeyStage } }], typecast: true });
    }

    let campaignContactRowsSynced = 0;
    if (sequenceStage === 'Connection Pending') {
      const rows = await fetchCampaignContactsRows();
      const pendingRows = rows.filter(r => (r.fields['Contact'] || []).includes(contactId) && ['Connection Requested', 'Found'].includes(r.fields['Sequence Stage'] || ''));
      if (pendingRows.length) {
        const today = new Date().toISOString().slice(0, 10);
        await airtableBatchPatch(CAMPAIGN_CONTACTS_TABLE, pendingRows.map(r => ({
          id: r.id,
          fields: { 'Sequence Stage': 'Connection Pending', 'Stage History': appendStageHistory(r.fields['Stage History'], 'Connection Pending', today) }
        })));
        campaignContactRowsSynced = pendingRows.length;
      }
    }

    res.json({ success: true, campaignContactRowsSynced });
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

  const { contactIds, companyId, campaignName } = req.body;
  if ((!contactIds || !contactIds.length) && !companyId) {
    return res.status(400).json({ error: 'contactIds or companyId is required' });
  }

  try {
    const [contactsData, touchPointsData, campaignRecord] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      campaignName ? findRecordByFieldName('Campaigns', 'Name', campaignName) : Promise.resolve(null)
    ]);
    const contactsById = {};
    (contactsData.records || []).forEach(r => { contactsById[r.id] = r; });
    // Sequence Stage is per-campaign now (Campaign Contacts), so it's only
    // fetched and included in the prompt when this update was triggered
    // from a specific campaign's Intelligence tab.
    const campaignContactRows = campaignRecord ? await fetchCampaignContactsRows() : [];

    const updatedContacts = [];
    for (const contactId of (contactIds || [])) {
      const record = contactsById[contactId];
      if (!record) continue;
      const f = record.fields || {};
      const touchPoints = (touchPointsData.records || [])
        .filter(r => (r.fields['Contact'] || []).includes(contactId))
        .map(r => ({ date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '', outcome: r.fields['Outcome'] || '' }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      let sequenceStageLine = '';
      if (campaignRecord) {
        const row = findCampaignContactRow(campaignContactRows, contactId, campaignRecord.id);
        if (row) sequenceStageLine = ` Sequence stage in the "${campaignName}" campaign: ${row.fields['Sequence Stage'] || ''}.`;
      }

      const prompt = `You are maintaining the AI Summary field for a contact in T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Contact: ${f['Full Name'] || ''}, ${f['Job Title'] || ''}.
Journey stage: ${f['Journey Stage'] || ''}.${sequenceStageLine}

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

// Advancing FROM "Pending Reply M1"/"M2" isn't explicitly in the brief
// (which only describes advancing from "Message 1/2 Sent"), but leaving no
// forward path once a contact is already waiting on a reply would be a
// clear gap - a reply landing while a contact sits in "Pending Reply M1"
// should still advance them the same way "Message 1 Sent" would. Keys here
// match the Sequence Stage single select's real option names exactly (no
// parentheses).
const SEQUENCE_STAGE_ADVANCE = {
  'Message 1 Sent': { replied: 'Ready for Message 2', noReply: 'Pending Reply M1' },
  'Pending Reply M1': { replied: 'Ready for Message 2', noReply: 'Pending Reply M1' },
  'Message 2 Sent': { replied: 'Ready for Message 3', noReply: 'Pending Reply M2' },
  'Pending Reply M2': { replied: 'Ready for Message 3', noReply: 'Pending Reply M2' },
  // No "Ready for Message 4" - the sequence stops at 3 messages, so a reply
  // at M3 goes straight to the terminal positive state instead of another
  // "Ready for..." draft step. "Message 3 Sent"/"Pending Reply M3" are new
  // Sequence Stage choices (auto-created by Airtable via typecast:true on
  // first write, same as every other new single-select value in this file).
  'Message 3 Sent': { replied: 'Meeting Booked', noReply: 'Pending Reply M3' },
  'Pending Reply M3': { replied: 'Meeting Booked', noReply: 'Pending Reply M3' }
};

// Appends one line to a Campaign Contacts row's Stage History log (creating
// the field's first line if empty) - the dated record of every stage
// transition that the pipeline funnel and period-scoped scorecards read,
// since Sequence Stage itself only ever holds the current value.
function appendStageHistory(existingHistory, stage, dateLabel) {
  const line = `[${dateLabel || new Date().toISOString().slice(0, 10)}] ${stage}`;
  return existingHistory ? existingHistory + '\n' + line : line;
}

// Parses a Stage History field back into [{date, stage}], most recent last,
// same order it was written in. Used by the sales-overview endpoint so the
// frontend never has to regex the raw text itself.
function parseStageHistory(historyText) {
  if (!historyText) return [];
  return historyText.split('\n').map(line => {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
    return m ? { date: m[1], stage: m[2] } : null;
  }).filter(Boolean);
}

// campaignId/campaignName scope the Sequence Stage advance + Next Message
// Draft write to that campaign's Campaign Contacts row (created on demand
// if this is the contact's first activity in the campaign). Conversation
// Context stays on the Contact record either way - it's the one running
// log of what's actually been said, not a campaign-specific concept.
// Without a campaign (the untagged top-level Context tab), there's no
// Campaign Contacts row to advance, so the stage/draft step is skipped
// entirely and only Conversation Context gets updated.
app.post('/api/context/parse-screenshot', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, text, campaignId, campaignName } = req.body;
  if (!image && !text) return res.status(400).json({ error: 'image or text is required' });

  try {
    const extractPrompt = `You are reading a LinkedIn DM or email exchange for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

${text ? `Here is the pasted conversation text:\n${text}` : 'Read the attached screenshot of the conversation.'}

Extract: the other person's name, a short summary of the message content/exchange, and whether they have replied (i.e. there is a message from them, not just Marcus).

If you cannot confidently identify the contact's name or read the message content, do not guess - set "confident" to false and explain why in "reason".

If the other person has replied, also classify the sentiment of their reply as exactly one of: "Positive", "Neutral", "Cold", "Negative". If they haven't replied, set sentiment to null.

If a timestamp for the most recent message is visible in the screenshot (e.g. "10:42 AM", "Tue 9:15am"), extract it and infer the day of week and hour it was sent. Format as "Monday 10am" (day name, then hour rounded to the nearest hour with am/pm, no leading zero). If no timestamp is visible, or this was pasted as text rather than a screenshot, set messageTime to null - do not guess.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "confident": boolean, "reason": string, "contactName": string, "messageSummary": string, "replied": boolean, "sentiment": string|null, "messageTime": string|null }`;

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
    const contactName = f['Full Name'] || parsed.contactName;
    const existingContext = f['Conversation Context'] || '';
    const dateLabel = new Date().toISOString().slice(0, 10);
    const newContext = (existingContext ? existingContext + '\n\n' : '') + `[${dateLabel}] ${parsed.messageSummary}`;

    await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactRecord.id, fields: { 'Conversation Context': newContext } }] });

    let currentStage = '', newStage = '', draft = null;

    let campaignRecord = null;
    if (campaignName) {
      campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
      if (campaignRecord) {
        const rows = await fetchCampaignContactsRows();
        const row = await getOrCreateCampaignContactRow(contactRecord.id, contactName, campaignRecord.id, campaignName, rows);

        currentStage = row.fields['Sequence Stage'] || '';
        const advance = SEQUENCE_STAGE_ADVANCE[currentStage];
        newStage = advance ? (parsed.replied ? advance.replied : advance.noReply) : currentStage;

        const rowUpdateFields = {};
        if (newStage && newStage !== currentStage) {
          rowUpdateFields['Sequence Stage'] = newStage;
          rowUpdateFields['Stage History'] = appendStageHistory(row.fields['Stage History'], newStage, dateLabel);
        }
        // Written unconditionally (not just on a stage change) since a
        // reply's sentiment is meaningful even when it doesn't move the
        // contact to a new stage - this is what the Section 3 sentiment
        // breakdown chart reads for contacts that don't have a Deal yet.
        if (parsed.sentiment) rowUpdateFields['Sentiment'] = parsed.sentiment;

        if (newStage.startsWith('Ready for Message')) {
          const draftPrompt = `You are drafting the next LinkedIn message for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM. This is for the "${campaignName}" campaign.

Contact: ${contactName}, ${f['Job Title'] || ''}.
AI Summary: ${f['AI Summary'] || 'none yet'}
Conversation so far: ${newContext}

Write the next message in the conversation, following on naturally from what they just said. UK English, no em dashes, peer to peer tone, 3-4 sentences, one observation and one question, signed off "Marcus". Return only the message text.`;
          draft = await callClaudeText(draftPrompt, 400);
          rowUpdateFields['Next Message Draft'] = draft;
        }

        if (Object.keys(rowUpdateFields).length) {
          await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, { records: [{ id: row.id, fields: rowUpdateFields }], typecast: true });
        }
      }
    }

    // Screenshots don't otherwise create a Touch Points row at all, so
    // without this the response-rate-by-type and best-time-to-message
    // panels on the Sales tab have nothing to read. Non-fatal on failure -
    // the primary Conversation Context / stage-advance saves above have
    // already succeeded regardless of whether this secondary write lands.
    try {
      const tpFields = {
        'Date': dateLabel,
        'Type': parsed.replied ? 'Inbound Reply' : 'LinkedIn Message',
        'Direction': parsed.replied ? 'Inbound' : 'Outbound',
        'Summary': parsed.messageSummary,
        'Contact': [contactRecord.id]
      };
      if (parsed.messageTime) tpFields['Message Time'] = parsed.messageTime;
      if (campaignRecord) tpFields['Campaign'] = [campaignRecord.id];
      await airtableRequest('POST', 'Touch Points', { records: [{ fields: tpFields }], typecast: true });
    } catch (tpErr) {
      console.warn('Touch Points write from screenshot parse failed (non-fatal):', tpErr.message);
    }

    res.json({
      success: true,
      contactName,
      contactId: contactRecord.id,
      messageSummary: parsed.messageSummary,
      replied: parsed.replied,
      sentiment: parsed.sentiment || null,
      messageTime: parsed.messageTime || null,
      previousStage: currentStage,
      newStage,
      draft,
      campaignScoped: !!campaignName
    });
    detectContentSignals().catch(err => console.warn('Content signal detection trigger failed:', err.message));
  } catch (err) {
    console.error('Parse screenshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reads a screenshot of a LinkedIn "Connections" list and extracts each
// visible connection's name and connection date. Only extraction happens
// here - matching against Airtable and updating Journey Stage is left to
// the same client-side runContextConnectionsImport() the CSV upload uses,
// so there's one matching implementation instead of two.
app.post('/api/context/parse-connections-screenshot', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image is required' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are reading a screenshot of a LinkedIn "Connections" list for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Extract every visible connection: their first name, last name, and the connection date if shown (e.g. "Connected 3 days ago", "Connected on August 12, 2026"). Convert relative dates using today's date, ${today}, and format as YYYY-MM-DD. If no date is visible or it can't be determined, use an empty string.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "connections": [ { "firstName": string, "lastName": string, "date": string } ] }`;

    const content = [
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
      { type: 'text', text: prompt }
    ];

    const parsed = await callClaudeJson(content, 1500);
    res.json({ success: true, connections: Array.isArray(parsed.connections) ? parsed.connections : [] });
  } catch (err) {
    console.error('Parse connections screenshot error:', err.message);
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
    detectContentSignals().catch(err => console.warn('Content signal detection trigger failed:', err.message));
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

// ===================== WIPE DATA (Settings > Danger zone) =====================
// Tables cleared by "Reset all data": the per-contact working data the app
// generates during outreach. Campaigns, Reps, Content Settings and Content
// are deliberately excluded - those are configuration/deliverables the user
// set up on purpose, not data a local-state reset should also destroy.
const WIPE_DATA_TABLES = ['Contacts', 'Companies', 'Touch Points', CAMPAIGN_CONTACTS_TABLE, 'Deals', CONTENT_SIGNALS_TABLE, 'Learning Data'];

// Fetches every record id in a table, following Airtable's `offset` pagination
// cursor. The plain `airtableRequest('GET', table)` used elsewhere in this
// file only returns the first page (<=100 records) - fine for routes that
// display or search records, but not safe for a delete-everything operation.
async function airtableFetchAllRecordIds(table) {
  const ids = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs.toString()}`, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Airtable error ${res.status}: ${err}`); }
    const data = await res.json();
    (data.records || []).forEach(r => ids.push(r.id));
    offset = data.offset;
  } while (offset);
  return ids;
}

// Airtable caps DELETE at 10 record ids per request, same limit as the
// batch writes in airtableBatchPatch above.
async function airtableBatchDelete(table, recordIds) {
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const qs = batch.map(id => `records[]=${encodeURIComponent(id)}`).join('&');
    const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Airtable error ${res.status}: ${err}`); }
  }
}

async function wipeAirtableTable(table) {
  const ids = await airtableFetchAllRecordIds(table);
  await airtableBatchDelete(table, ids);
  return ids.length;
}

// Deletes every record from WIPE_DATA_TABLES. Each table is wiped
// independently and failures are swallowed per-table (same convention as
// fetchCampaignContactsRows/Learning Data elsewhere) - a table that doesn't
// exist in a given base, or one Airtable call that fails, shouldn't stop the
// rest of the wipe from completing.
app.post('/api/wipe-data', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const results = {};
  for (const table of WIPE_DATA_TABLES) {
    try {
      results[table] = { deleted: await wipeAirtableTable(table) };
    } catch (err) {
      console.warn(`Wipe data: could not clear "${table}" (table may not exist yet):`, err.message);
      results[table] = { error: err.message };
    }
  }
  res.json({ success: true, results });
});

// ===================== DELETE GRID (Home page) =====================
// Grids only exist client-side (see the "gridName"/"Grid Name" notes above),
// so the client tells us which Contact/Company names belonged to the grid
// being deleted - each name is looked up in Airtable and, if found, its
// record is removed. Companies shared with another grid are the client's
// responsibility to exclude from companyNames before calling this (it has
// no way to know about other grids).
app.delete('/api/grid', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactNames = [], companyNames = [] } = req.body || {};

  try {
    const contactIds = (await Promise.all(
      contactNames.map(name => findRecordByFieldName('Contacts', 'Full Name', name))
    )).filter(Boolean).map(r => r.id);

    const companyIds = (await Promise.all(
      companyNames.map(name => findRecordByFieldName('Companies', 'Company Name', name))
    )).filter(Boolean).map(r => r.id);

    if (contactIds.length) await airtableBatchDelete('Contacts', contactIds);
    if (companyIds.length) await airtableBatchDelete('Companies', companyIds);

    res.json({ success: true, deletedContacts: contactIds.length, deletedCompanies: companyIds.length });
  } catch (err) {
    console.error('Grid delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== SCHEDULED SYNC JOBS =====================
// Both run silently in the background and never block the UI - failures
// are logged, not thrown, same as every other cron-eligible job in this
// file (detectContentSignals, etc).

// Daily 6am: Trigify contact post sync + post-based job change detection.
cron.schedule('0 6 * * *', () => {
  syncTrigifyContactPosts().catch(err => console.warn('Scheduled Trigify contact sync failed:', err.message));
});

// Weekly Sunday 7am: Serper-based job title drift detection.
cron.schedule('0 7 * * 0', () => {
  checkContactJobChanges().catch(err => console.warn('Scheduled job change check failed:', err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
