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
app.post('/api/airtable/campaign', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { name, goal, product, targetIcp, contactIds, sequenceTemplates, strategyNotes, successMetric, startDate, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const searchRes = await fetch(
      `${AIRTABLE_URL}/Campaigns?filterByFormula=${encodeURIComponent(`{Name}="${name}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records && searchData.records[0];
    if (existing) {
      return res.json({ success: true, skipped: true, recordId: existing.id });
    }

    const data = await airtableRequest('POST', 'Campaigns', {
      records: [{
        fields: {
          'Name': name,
          'Goal': goal || '',
          'Product': product || '',
          'Target ICP': targetIcp || '',
          'Contact IDs': (contactIds || []).join(', '),
          'Sequence Templates': sequenceTemplates || '',
          'Strategy Notes': strategyNotes || '',
          'Success Metric': successMetric || '',
          'Start Date': startDate || '',
          'Status': status || 'Draft'
        }
      }]
    });
    res.json({ success: true, skipped: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable campaign create error:', err.message);
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
      'Direction': 'Outbound',
      'Replied': outcome === 'Replied'
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
// Data table (fields: Type, Analysis, Record Count, Date - unconfirmed,
// guessed to match existing table-field-naming conventions). Every future
// analysis, including /api/intelligence, pulls this table back in as
// context so it compounds with each upload instead of starting fresh.

async function fetchLearningData() {
  try {
    const data = await airtableRequest('GET', 'Learning Data');
    return (data.records || []).map(r => ({
      type: r.fields['Type'] || '',
      analysis: r.fields['Analysis'] || '',
      recordCount: r.fields['Record Count'] || 0,
      date: r.fields['Date'] || ''
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
        'Date': new Date().toISOString().slice(0, 10)
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

app.get('/api/track/insights', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const conversions = await fetchConversions();

    const topIcpRoles = rankCounts(conversions, c => c.icpRole)
      .slice(0, 5)
      .map(([role, count]) => `${role} — ${count} conversion${count === 1 ? '' : 's'}`);

    const topProducts = rankCounts(conversions, c => c.product)
      .slice(0, 5)
      .map(([product, count]) => `${product} — ${count} conversion${count === 1 ? '' : 's'}`);

    const topMethods = rankCounts(conversions, c => c.communicationMethod)
      .slice(0, 5)
      .map(([method, count]) => `${method} — ${count} conversion${count === 1 ? '' : 's'}`);

    const touchCounts = conversions.map(c => c.touchPointCount).filter(n => typeof n === 'number' && n > 0);
    const avgTouchPoints = touchCounts.length
      ? Math.round((touchCounts.reduce((s, n) => s + n, 0) / touchCounts.length) * 10) / 10
      : null;

    res.json({
      topIcpRoles,
      topProducts,
      topMethods,
      avgTouchPoints,
      conversionCount: conversions.length
    });
  } catch (err) {
    console.error('Track insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== INTELLIGENCE =====================
// Pulls the full contact + touch point picture from Airtable, hands it to
// Claude, and asks for four sections of outreach intelligence back as JSON.

app.post('/api/intelligence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const [contactsData, touchPointsData, learningData, conversions] = await Promise.all([
      airtableRequest('GET', 'Contacts'),
      airtableRequest('GET', 'Touch Points'),
      fetchLearningData(),
      fetchConversions()
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

LEARNING DATA from past customer and deal analysis (${learningData.length} analyses on file - use this to sharpen your suggestions, it reflects real historical ICP and sales patterns):
${learningDataContext(learningData)}

CONVERSIONS - actual meetings booked, logged with what led to them (${conversions.length} on file - this is ground truth for what's actually working, weight it heavily):
${conversionsContext(conversions)}

Analyse this data and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "campaignSuggestions": string[],
  "coldContacts": string[],
  "relationshipHealth": string[],
  "messageDrafts": [{ "contactName": string, "draft": string }]
}

Guidance for each section:
- campaignSuggestions: 3-5 concrete outreach campaign or angle ideas based on real patterns in the data (shared roles, industries, company clusters, recurring themes in notes) and, where relevant, the learning data and conversion patterns above (ICP profiles, products and communication methods that have actually converted).
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
  "matchedContactNames": string[],
  "sequence": {
    "message1": { "content": string, "timing": string },
    "followUp1": { "content": string, "timing": string },
    "followUp2": { "content": string, "timing": string }
  },
  "strategyBrief": string,
  "estimatedConversions": string
}

Guidance:
- goal: one short sentence summarising the campaign's goal, drawn from the conversation.
- matchedContactNames: full names of contacts from the list above whose role, company or notes plausibly match the audience described in the conversation. Only include contacts that actually appear in the list above. Return an empty array if nothing matches rather than inventing names.
- sequence: three outreach stages. If an existing strategy/script was mentioned in the conversation, adapt it rather than starting from scratch. Otherwise write fresh copy. UK English, no em dashes, peer to peer tone, one observation and one question per message, 3-4 sentences, signed off "Marcus". "timing" is when to send relative to the previous step, e.g. "Day 0", "3 days after message 1", "7 days after follow-up 1".
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
