// v2
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const mammoth = require('mammoth');
const crypto = require('crypto');

const app = express();

const BASIC_AUTH_USER = process.env.RAILWAY_BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.RAILWAY_BASIC_AUTH_PASS;

if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    const decoded = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const sepIndex = decoded.indexOf(':');
    const user = sepIndex === -1 ? decoded : decoded.slice(0, sepIndex);
    const pass = sepIndex === -1 ? '' : decoded.slice(sepIndex + 1);

    if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) return next();

    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    res.status(401).send('Authentication required');
  });
}

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

// Shared LinkedIn search - used by GET /api/search-contact (client-driven,
// one cell at a time) and POST /api/grid/run-search (server-driven, a whole
// grid's empty cells in one job). Throws with a `.status` of 500 when
// SERPER_API_KEY is missing, matching the response GET /api/search-contact
// always returned for that case; a plain Error otherwise.
async function searchContactViaSerper(company, jobTitle){
  if(!process.env.SERPER_API_KEY){
    const err = new Error('SERPER_API_KEY is not configured');
    err.status = 500;
    throw err;
  }

  // Twenty2 Collective is a Perth, WA outreach agency - "Australia" in the
  // query text nudges Google toward AU-based profiles when a role/company
  // combination is ambiguous (a common job title at a company with offices
  // in multiple countries), and gl:'au' plus location:'Australia' bias
  // Serper/Google's own ranking toward Australian search results the same
  // way browsing from Australia would.
  const query = `${company} ${jobTitle} linkedin Australia Perth OR "Western Australia"`;
  const serperRes = await fetch(SERPER_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q: query, gl: 'au', location: 'Australia' })
  });

  if(!serperRes.ok){
    throw new Error(`Serper API error: ${serperRes.status}`);
  }

  const data = await serperRes.json();
  const results = data.organic || [];

  const companyWords = company.toLowerCase().split(/\s+/).filter(Boolean);
  const titleWords = jobTitle.toLowerCase().split(/\s+/).filter(Boolean);

  const match = results.find(r => isConfidentMatch(r, companyWords, titleWords));
  if(!match) return { found: false };

  return { found: true, name: extractName(match.title), url: match.link };
}

app.get('/api/search-contact', async (req, res) => {
  const company = (req.query.company || '').trim();
  const jobTitle = (req.query.jobTitle || '').trim();

  if(!company || !jobTitle){
    return res.status(400).json({ found: false, error: 'company and jobTitle query params are required' });
  }

  try {
    const result = await searchContactViaSerper(company, jobTitle);
    return res.json(result);
  } catch(err){
    console.error('Search error for', company, jobTitle, '-', err.message);
    return res.status(err.status || 500).json({ found: false, error: err.status ? err.message : 'search_failed' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 't2c-outreach-crm.html'));
});

// ===================== AIRTABLE CONFIG =====================
const AIRTABLE_BASE_ID = 'appKe5oopNpheq32n';
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

// Airtable enforces 5 requests/second per base. This app fires a lot of
// independent reads in parallel on a single page load (grid, contact,
// campaign, sequence, dead contact, reps, settings, job-change signals,
// etc.), which can burst past that and come back 429 - especially right
// after a deploy restart when several people load the app at once. Wraps
// every Airtable fetch below so a 429 is retried with a short backoff
// instead of failing the request outright (Airtable's own guidance is to
// back off and retry on 429; 3 attempts with a growing delay absorbs a
// burst without making the rare still-limited case much slower).
async function airtableFetchWithRetry(url, options, retries = 3, delayMs = 1000) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= retries) return res;
    await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
  }
}

async function airtableRequest(method, table, body) {
  const res = await airtableFetchWithRetry(`${AIRTABLE_URL}/${encodeURIComponent(table)}`, {
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
  const res = await airtableFetchWithRetry(`${AIRTABLE_URL}/${encodeURIComponent(table)}/${recordId}`, {
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
  const res = await airtableFetchWithRetry(
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
  return airtableFetchAllPaginated(table, '');
}

// Same offset-following pagination as airtableFetchAllRecords above, but
// also carries an arbitrary extra query string (filterByFormula, sort,
// etc.) on every page - for routes that need a raw fetch instead of
// airtableRequest/airtableFetchAllRecords because they append query params
// to a table name those helpers would encodeURIComponent() whole (see the
// GET /api/airtable/company route below for why). Used wherever a raw,
// single-page `fetch(...&filterByFormula=...)` call was silently capping
// results at Airtable's 100-per-page default.
async function airtableFetchAllPaginated(table, extraQueryString) {
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const url = extraQueryString
      ? `${AIRTABLE_URL}/${encodeURIComponent(table)}?${extraQueryString}&${qs.toString()}`
      : `${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs.toString()}`;
    const res = await airtableFetchWithRetry(url, { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
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
  const records = await airtableFetchAllRecords('Campaigns');
  return records.find(r => (r.fields['Name'] || '') === campaignName) || null;
}

function isAirtableRecordId(id) {
  return /^rec[A-Za-z0-9]{14}$/.test(id || '');
}

// Campaign-scoped routes (Analytics/Sales tabs) are given either the
// campaign's stable Airtable record id - once syncCampaignToAirtable has
// cached one client-side - or, for a campaign that hasn't synced since
// that field was added, its Name. Name alone is what these routes used to
// resolve on exclusively, but it's cached client-side once at creation and
// never refreshed: a direct rename in Airtable (or a redrafted title on
// resave) silently breaks every subsequent name-based lookup with
// "Campaign not found in Airtable" even though the record still exists.
// Resolving by record id first sidesteps that drift entirely.
async function resolveCampaignRecord(idOrName) {
  if (!idOrName) return null;
  if (isAirtableRecordId(idOrName)) {
    const record = await airtableGetRecord('Campaigns', idOrName);
    if (record) return record;
  }
  return findCampaignRecordByName(idOrName);
}

// Shared Claude call - `content` is either a plain string (text-only) or an
// array of content blocks (for vision/PDF document prompts). Every new
// Claude-calling route added in the Context tab work uses this instead of
// re-inlining the fetch/parse boilerplate that the older routes each have.
async function callClaudeMessages(content, maxTokens, system) {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }]
  };
  if (system) body.system = system;
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
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

// Strips a ```json ... ``` or ``` ... ``` fence Claude sometimes wraps a
// response in despite being told not to, so callers doing their own
// JSON.parse (rather than callClaudeJson's object-shaped regex above) don't
// choke on the fence markers. Used by the Logger routes below, which parse
// bare-array/object responses directly.
function stripCodeFences(text) {
  return String(text || '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
}

// ===================== MIDDLEWARE =====================
app.use(express.json());

// ===================== AIRTABLE ROUTES =====================

// Fetch all contacts from Airtable
// Contacts.Company is a linked-record field (createOrUpdateAirtableContact
// below writes it as fields['Company'] = [companyRecord.id]), so a plain
// GET returns it as an array of record ids, not the company name text the
// client has always expected (hydrateContactsFromAirtable does
// `company: f['Company'] || ''`, with no array handling). Resolved here,
// server-side, so every caller of this route keeps getting a plain string
// without needing its own fix - an unresolved array reaching the client
// silently broke every grid-cell match (string comparison against a real
// company name never matches an array) and crashed esc() wherever a
// contact's company was rendered (Array has no .replace).
app.get('/api/airtable/contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const [contactRecords, companyRecords] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies')
    ]);

    const companyNameById = {};
    companyRecords.forEach(r => { companyNameById[r.id] = r.fields['Company Name'] || ''; });

    const records = contactRecords.map(r => {
      const companyField = r.fields['Company'];
      if (!Array.isArray(companyField)) return r;
      return {
        ...r,
        fields: { ...r.fields, 'Company': companyNameById[companyField[0]] || '' }
      };
    });

    res.json(records);
  } catch (err) {
    console.error('Airtable contact list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shared create-or-update-a-Contact logic - used by POST /api/airtable/contact
// (client-driven, one contact at a time) and POST /api/grid/run-search
// (server-driven, writing each match to Airtable as the grid search finds
// it). Throws with a `.status` of 400 for a missing name/company, matching
// the response POST /api/airtable/contact always returned for that case; a
// plain Error otherwise.
//
// Note: "gridName" was previously written to a "Grid Name" field that
// does not exist on the real Contacts table - removed rather than added,
// per instruction not to create missing fields. Grid membership is still
// tracked locally in the app's own state; it just isn't mirrored to
// Airtable right now.
async function createOrUpdateAirtableContact({ name, company, role, linkedinUrl, state: contactState, icpRoleCategory, notes, companyLinkedinUrl, apolloTitle, gridName }) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }

  // company is optional - e.g. an Apollo result with no organisation on the
  // person's record. Left uncreated here rather than defaulted to a
  // placeholder company: incompleteGridContacts (t2c-outreach-crm.html)
  // picks up any synced contact missing exactly one of company/role, so a
  // blank Company link is what makes this contact a candidate for "Run
  // daily search"'s fill-missing-field pass (searchMissingContactField)
  // finding the real company later.
  //
  // Looked up before the existing-contact check (not just in the create
  // branch below) so a re-encountered contact whose Company link never got
  // set - e.g. found via grid search before its company had finished
  // syncing to Airtable - gets it backfilled too, not just contacts created
  // fresh from this call.
  let companyRecord = null;
  if (company) {
    const companySearchRes = await airtableFetchWithRetry(
      `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${company}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const companySearchData = await companySearchRes.json();
    companyRecord = companySearchData.records && companySearchData.records[0];
  }

  const searchRes = await airtableFetchWithRetry(
    `${AIRTABLE_URL}/Contacts?filterByFormula=${encodeURIComponent(`{Full Name}="${name}"`)}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  const searchData = await searchRes.json();
  const existing = searchData.records && searchData.records[0];
  if (existing) {
    const patchFields = {};
    if (icpRoleCategory) patchFields['ICP Role Category'] = icpRoleCategory;
    if (companyRecord) patchFields['Company'] = [companyRecord.id];
    if (Object.keys(patchFields).length) {
      await airtableRequest('PATCH', 'Contacts', {
        records: [{ id: existing.id, fields: patchFields }],
        typecast: true
      });
    }
    // Separate best-effort write, same reasoning as the Apollo Title write
    // on the create branch below - the real Contacts table's exact field
    // set isn't confirmed to include it, so it's never bundled into the
    // patch above where a missing field would fail the whole write.
    if (apolloTitle) {
      try {
        await airtableRequest('PATCH', 'Contacts', { records: [{ id: existing.id, fields: { 'Apollo Title': apolloTitle } }], typecast: true });
      } catch (apolloTitleErr) {
        console.warn('Best-effort Apollo Title field write failed:', apolloTitleErr.message);
      }
    }
    // Same best-effort convention as Apollo Title above - Contacts.Grid Name
    // isn't a confirmed real field yet (add a single-line text field named
    // exactly "Grid Name" to the Contacts table to enable this), so a
    // missing field only drops this tag, not the whole contact sync. Tags
    // a contact directly rather than relying on its Company's Grid Name -
    // a company shared across grids no longer drags every one of its
    // contacts along into a grid they were never actually imported for.
    // Appended, not overwritten, same multi-grid list convention
    // Companies.Grid Name already uses (see findOrCreateCompanyRecord).
    if (gridName) {
      try {
        const gridNames = parseGridNameList(existing.fields['Grid Name']);
        if (!gridNames.includes(gridName)) {
          gridNames.push(gridName);
          await airtableRequest('PATCH', 'Contacts', { records: [{ id: existing.id, fields: { 'Grid Name': gridNames.join(', ') } }], typecast: true });
        }
      } catch (gridNameErr) {
        console.warn('Best-effort Grid Name field write failed (add a "Grid Name" text field to Contacts to enable this):', gridNameErr.message);
      }
    }
    return { success: true, skipped: true, recordId: existing.id };
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
  if (companyRecord) fields['Company'] = [companyRecord.id];

  const data = await airtableRequest('POST', 'Contacts', {
    records: [{ fields }],
    typecast: true
  });
  const recordId = data.records[0].id;

  // Best-effort, same reasoning as the Rep field write on Touch Points
  // (POST /api/airtable/touchpoint) - Apollo's raw title goes here instead
  // of the main create above so an unrecognised field name never fails the
  // primary contact creation, just this secondary write.
  if (apolloTitle) {
    try {
      await airtableRequest('PATCH', 'Contacts', { records: [{ id: recordId, fields: { 'Apollo Title': apolloTitle } }], typecast: true });
    } catch (apolloTitleErr) {
      console.warn('Best-effort Apollo Title field write failed:', apolloTitleErr.message);
    }
  }

  if (gridName) {
    try {
      await airtableRequest('PATCH', 'Contacts', { records: [{ id: recordId, fields: { 'Grid Name': gridName } }], typecast: true });
    } catch (gridNameErr) {
      console.warn('Best-effort Grid Name field write failed (add a "Grid Name" text field to Contacts to enable this):', gridNameErr.message);
    }
  }

  // Trigify monitor creation happens later, in PATCH /api/context/
  // contact-fields once this contact actually reaches Sequence Stage
  // "Connected" - not here at creation, so a contact that's found but never
  // connects with never gets an unnecessary Trigify search opened for them.
  return { success: true, skipped: false, recordId };
}

// Create or update a contact in Airtable
app.post('/api/airtable/contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const result = await createOrUpdateAirtableContact(req.body);
    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Airtable contact create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ===================== GRID DAILY SEARCH (server-side) =====================
// Runs the same search + Airtable-write that the client used to drive one
// cell at a time (see runDailySearch in t2c-outreach-crm.html), but as a
// single server-side job over a whole grid's empty cells - each match is
// written to Airtable as it's found, not batched at the end. Grids
// themselves are a client-only concept (see the persistState comment in
// t2c-outreach-crm.html - grid definitions live in localStorage, never
// this server), so the client sends the exact {company, role} cells to
// search rather than this route trying to resolve a gridId into companies/
// roles on its own; gridId here is just an opaque label carried on the job.
//
// Jobs live in memory only (no restart-survival, same tradeoff as every
// other piece of ephemeral server state in this file) and are swept up a
// while after finishing so this map can't grow unbounded.
const gridSearchJobs = new Map();
const GRID_SEARCH_JOB_TTL_MS = 15 * 60 * 1000;

// gridIds with a job currently in flight - checked by POST /api/grid/run-search
// to reject a second concurrent search for the same grid (see the 409 below).
// Released in a .finally() once the job settles, success or failure, so a
// crashed/errored job can't strand a grid locked forever.
const runningGridSearchJobs = new Set();

// If this grid belongs to a campaign (campaignName, resolved client-side
// via currentGridCampaignName() - a grid linked to more than one campaign
// sends none, same ambiguity rule the rest of the app already uses for
// this), links a newly-found contact into that campaign's Campaign
// Contacts table too: Contact, Campaign, Sequence Stage "Found" (Campaign
// Contacts' actual stage field - "Journey Stage" only exists on the
// Contacts table) and Connection Sent Date stamped to today, same as every
// other place a contact enters a campaign.
//
// Checks for an existing row for this (contact, campaign) pair first -
// if one exists with Sequence Stage "Excluded", it's stayed there because
// someone deliberately removed this person from the campaign, so a later
// day's grid search re-finding them must not silently re-include them;
// skip and leave the row untouched. Any other existing row (already
// further along than "Found") is also left alone -
// getOrCreateCampaignContactRow is create-only-if-missing, so this only
// ever creates a fresh row when none exists yet. Failures here are logged
// and swallowed rather than failing the cell - the contact itself was
// already saved successfully by createOrUpdateAirtableContact above.
async function linkGridContactToCampaign(contactId, contactName, campaignRecord, rows) {
  try {
    const existing = findCampaignContactRow(rows, contactId, campaignRecord.id);
    if (existing) {
      if (existing.fields['Sequence Stage'] === 'Excluded') {
        console.log(`Skipping campaign link for ${contactName} - marked Excluded from ${campaignRecord.fields['Name']}`);
      }
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    await getOrCreateCampaignContactRow(contactId, contactName, campaignRecord.id, campaignRecord.fields['Name'], rows, {
      'Connection Sent Date': today
    });
  } catch (err) {
    console.warn('Could not link grid-found contact to campaign:', err.message);
  }
}

// Airtable-only existence check for the grid-deleted-mid-run guard in
// runGridSearchJob below - distinct from findRecordByFieldName because that
// helper doesn't check res.ok, so a transient Airtable error (rate limit,
// auth blip) comes back indistinguishable from "genuinely zero records" and
// would wrongly cancel an otherwise-healthy job. Here, only a confirmed OK
// response with zero matches counts as "really gone"; any fetch failure
// defaults to "assume it still exists" and lets the job keep running.
async function gridStillExistsInAirtable(gridId) {
  try {
    const res = await airtableFetchWithRetry(
      `${AIRTABLE_URL}/Grids?filterByFormula=${encodeURIComponent(`{Grid ID}="${gridId}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!res.ok) return true;
    const data = await res.json();
    return !!(data.records && data.records.length);
  } catch (err) {
    return true;
  }
}

// "Grid Name" holds a comma-separated list of every grid this company is
// on, not just one - a company (RAC WA, BHP, etc.) is routinely shared
// across multiple grids (deleteGridConfirmed/confirmApolloImport already
// account for that on the delete side), so a single value here would let
// whichever grid touched the company first silently lock every other grid
// out of ever seeing it again once GET /api/airtable/company?gridName=
// filters by it. Same join style as Grids.Columns elsewhere in this file.
function parseGridNameList(raw) {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Shared find-or-create-a-Company lookup - used by POST /api/airtable/company
// (client-driven, one company at a time, e.g. "Add company") and the
// fillMissing branch of runGridSearchJob below (server-driven, once a
// contact's missing company has been found by search). Same behaviour
// either way: returns the existing record if the name already matches one,
// appending gridName onto its Grid Name list if it isn't already there,
// otherwise creates a fresh record.
async function findOrCreateCompanyRecord(name, gridName) {
  const searchRes = await airtableFetchWithRetry(
    `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${name}"`)}`,
    { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
  );
  const searchData = await searchRes.json();
  const existing = searchData.records && searchData.records[0];
  if (existing) {
    if (gridName) {
      const gridNames = parseGridNameList(existing.fields['Grid Name']);
      if (!gridNames.includes(gridName)) {
        gridNames.push(gridName);
        await airtableRequest('PATCH', 'Companies', { records: [{ id: existing.id, fields: { 'Grid Name': gridNames.join(', ') } }] });
      }
    }
    return { id: existing.id, skipped: true };
  }

  const fields = { 'Company Name': name };
  if (gridName) fields['Grid Name'] = gridName;
  const data = await airtableRequest('POST', 'Companies', { records: [{ fields }] });
  return { id: data.records[0].id, skipped: false };
}

// Reverse lookup for the fillMissing half of runDailySearch: given a
// contact's name (and whichever of company/role is already known), finds
// the other one. Distinct from searchContactViaSerper above, which finds a
// brand new person for a known (company, role) pair - this instead
// confirms one missing fact about an already-known person, so it's a
// single targeted Serper query plus a Claude extraction pass rather than
// searchContactViaSerper's confident-match heuristics (there's no LinkedIn
// URL match to score here, just "what does the text say").
async function searchMissingContactField({ name, linkedinUrl, knownCompany, knownRole, missingField }) {
  if (!process.env.SERPER_API_KEY) {
    const err = new Error('SERPER_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not configured');
    err.status = 500;
    throw err;
  }

  const slug = extractLinkedInSlug(linkedinUrl || '');
  const query = slug ? `site:linkedin.com/in/${slug}` : `${name} ${knownCompany || knownRole || ''} linkedin Australia`.trim();
  const serperRes = await fetch(SERPER_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'au', location: 'Australia' })
  });
  if (!serperRes.ok) throw new Error(`Serper API error: ${serperRes.status}`);
  const data = await serperRes.json();
  const snippets = (data.organic || []).slice(0, 5).map(r => `${r.title || ''}\n${r.snippet || ''}`).join('\n\n');
  if (!snippets) return { found: false };

  const fieldLabel = missingField === 'company' ? "this person's current employer (company name only)" : "this person's current job title";
  const prompt = `Search results for "${name}"${knownCompany ? ` at ${knownCompany}` : ''}${knownRole ? ` (${knownRole})` : ''}:
${snippets}

Based only on the above search results, what is ${fieldLabel}? Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "found": boolean, "value": string }

Set "found" to false and "value" to "" if the search results don't give a confident, specific answer - don't guess.`;

  const parsed = await callClaudeJson(prompt, 300);
  if (!parsed || !parsed.found || !parsed.value) return { found: false };
  return { found: true, value: String(parsed.value).trim() };
}

async function runGridSearchJob(job, cells, campaignName) {
  // findCampaignRecordByName, not findRecordByFieldName - a campaign name
  // containing a double quote would break the latter's filterByFormula
  // string interpolation and silently resolve to "not found" (see that
  // function's own comment for the full story).
  const campaignRecord = campaignName ? await findCampaignRecordByName(campaignName) : null;
  const campaignContactRows = campaignRecord ? await fetchCampaignContactsRows() : null;

  const finish = (status, error) => {
    job.status = status;
    if (error) job.error = error;
    job.finishedAt = Date.now();
    setTimeout(() => gridSearchJobs.delete(job.id), GRID_SEARCH_JOB_TTL_MS);
  };

  // How often (in cells processed) to re-check job.cancelled (set by POST
  // /api/grid/cancel-search) and that the grid still exists in Airtable -
  // not every single cell, since the existence check is an extra Airtable
  // call that only matters in the rare case of a cancel/delete mid-run.
  const CHECK_EVERY = 5;

  for (let i = 0; i < cells.length; i++) {
    if (job.cancelled) return finish('cancelled');

    if (i > 0 && i % CHECK_EVERY === 0 && !(await gridStillExistsInAirtable(job.gridId))) {
      console.warn(`Grid search job ${job.id}: grid ${job.gridId} no longer exists in Airtable, stopping.`);
      return finish('cancelled', 'Grid no longer exists');
    }

    const cell = cells[i];
    let result;
    if (cell.kind === 'fillMissing') {
      const { contactId, name, linkedinUrl, knownCompany, knownRole, missingField, gridName } = cell;
      try {
        const searchResult = await searchMissingContactField({ name, linkedinUrl, knownCompany, knownRole, missingField });
        if (searchResult.found) {
          const patchFields = {};
          if (missingField === 'role') {
            patchFields['Job Title'] = searchResult.value;
          } else {
            const companyRecord = await findOrCreateCompanyRecord(searchResult.value, gridName);
            patchFields['Company'] = [companyRecord.id];
          }
          await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: patchFields }], typecast: true });
          job.filledCount++;
          result = { kind: 'fillMissing', contactId, missingField, found: true, value: searchResult.value };
        } else {
          result = { kind: 'fillMissing', contactId, missingField, found: false };
        }
      } catch (err) {
        console.warn('Fill-missing-field search failed for', name, '-', err.message);
        result = { kind: 'fillMissing', contactId, missingField, found: false, error: err.message };
      }
    } else {
      const { company, role } = cell;
      try {
        const searchResult = await searchContactViaSerper(company, role);
        if (searchResult.found) {
          const contactResult = await createOrUpdateAirtableContact({
            name: searchResult.name,
            company,
            role,
            linkedinUrl: searchResult.url,
            state: 'found',
            icpRoleCategory: role
          });
          if (campaignRecord) {
            await linkGridContactToCampaign(contactResult.recordId, searchResult.name, campaignRecord, campaignContactRows);
          }
          job.foundCount++;
          result = { kind: 'newContact', company, role, found: true, name: searchResult.name, url: searchResult.url, recordId: contactResult.recordId };
        } else {
          result = { kind: 'newContact', company, role, found: false };
        }
      } catch (err) {
        console.warn('Grid search failed for', company, role, '-', err.message);
        result = { kind: 'newContact', company, role, found: false, error: err.message };
      }
    }
    job.results.push(result);
    job.completed++;
    if (job.completed < job.total) await sleep(300);
  }
  finish('done');
}

// Kicks off a grid's daily search server-side and returns a jobId
// immediately - the client polls GET /api/grid/run-search/:jobId for
// progress instead of holding one long request open.
app.post('/api/grid/run-search', (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY is not configured' });

  const { gridId, cells, campaignName } = req.body;
  if (!gridId) return res.status(400).json({ error: 'gridId is required' });
  if (!Array.isArray(cells) || !cells.length) return res.status(400).json({ error: 'cells (array of {company, role}) is required' });
  // fillMissing cells (see runDailySearch/searchMissingContactField) need
  // Claude to extract the missing field from search results, on top of the
  // Serper key every cell kind needs - only required when this job actually
  // has one, so a plain empty-cells-only search still works without it.
  if (cells.some(c => c.kind === 'fillMissing') && !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }
  if (runningGridSearchJobs.has(gridId)) {
    return res.status(409).json({ error: 'A daily search is already running for this grid' });
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    gridId,
    status: 'running',
    total: cells.length,
    completed: 0,
    foundCount: 0,
    filledCount: 0,
    results: [],
    error: null,
    cancelled: false,
    startedAt: Date.now()
  };
  gridSearchJobs.set(jobId, job);
  runningGridSearchJobs.add(gridId);

  runGridSearchJob(job, cells, campaignName)
    .catch(err => {
      console.error('Grid search job failed:', err.message);
      job.status = 'error';
      job.error = err.message;
    })
    .finally(() => runningGridSearchJobs.delete(gridId));

  res.json({ jobId, total: cells.length });
});

// Poll a grid search job's progress - completed/total/foundCount for a
// status indicator, and results (one entry per cell processed so far) for
// the client to reconcile grid cells against as they land.
app.get('/api/grid/run-search/:jobId', (req, res) => {
  const job = gridSearchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    foundCount: job.foundCount,
    filledCount: job.filledCount,
    results: job.results,
    error: job.error
  });
});

// Stops a running search job for the given gridId - called from the Cancel
// button on the grid search status indicator (t2c-outreach-crm.html,
// cancelGridSearch). Doesn't kill anything mid-flight: runGridSearchJob's
// loop only checks job.cancelled once per cell (same cadence as its grid-
// existence check above), so the cell already in progress still finishes
// and gets saved before the job actually stops.
app.post('/api/grid/cancel-search', (req, res) => {
  const { gridId } = req.body;
  if (!gridId) return res.status(400).json({ error: 'gridId is required' });

  const job = [...gridSearchJobs.values()].find(j => j.gridId === gridId && j.status === 'running');
  if (!job) return res.json({ success: false, message: 'No running search found for this grid' });

  job.cancelled = true;
  res.json({ success: true, jobId: job.id });
});

// Create a Contact from a website lead webhook (e.g. an AI profile/scorecard
// tool). Always creates a new record - unlike POST /api/airtable/contact,
// there's no skip-if-existing check here since each webhook payload
// represents a fresh lead submission.
app.post('/api/leads/website', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const {
    client_first_name, client_company, email,
    profile_archetype, profile_archetype_desc,
    profile_overall_score, profile_people_score, profile_productivity_score, profile_performance_score,
    profile_primary_leak, profile_secondary_leak,
    profile_insight1_title, profile_insight1_body,
    profile_insight2_title, profile_insight2_body,
    profile_insight3_title, profile_insight3_body,
    profile_strength, profile_recommendation, profile_cta_reason
  } = req.body;

  if (!client_first_name || !client_company) {
    return res.status(400).json({ error: 'client_first_name and client_company are required' });
  }

  try {
    const fields = {
      'Full Name': client_first_name,
      'Journey Stage': 'Website Lead',
      'AI Summary': JSON.stringify({
        archetype: profile_archetype,
        archetypeDesc: profile_archetype_desc,
        overallScore: profile_overall_score,
        peopleScore: profile_people_score,
        productivityScore: profile_productivity_score,
        performanceScore: profile_performance_score,
        primaryLeak: profile_primary_leak,
        secondaryLeak: profile_secondary_leak,
        insights: [
          { title: profile_insight1_title, body: profile_insight1_body },
          { title: profile_insight2_title, body: profile_insight2_body },
          { title: profile_insight3_title, body: profile_insight3_body }
        ],
        strength: profile_strength,
        recommendation: profile_recommendation,
        ctaReason: profile_cta_reason
      })
    };
    if (email) fields['Email'] = email;

    const companySearchRes = await airtableFetchWithRetry(
      `${AIRTABLE_URL}/Companies?filterByFormula=${encodeURIComponent(`{Company Name}="${client_company}"`)}`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const companySearchData = await companySearchRes.json();
    const companyRecord = companySearchData.records && companySearchData.records[0];
    if (companyRecord) fields['Company'] = [companyRecord.id];

    const data = await airtableRequest('POST', 'Contacts', {
      records: [{ fields }],
      typecast: true
    });

    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Website lead create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List Contacts whose Journey Stage is "Website Lead" for the Research >
// Profiles tab, with each contact's Change Value Check report (saved as a
// JSON string in AI Summary by POST /api/leads/website above) parsed out
// server-side so the frontend doesn't need to guess at its shape.
app.get('/api/leads/website', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const [contactRecords, companyRecords] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies')
    ]);
    const companiesById = {};
    companyRecords.forEach(r => { companiesById[r.id] = r; });

    const leads = contactRecords
      .filter(r => r.fields['Journey Stage'] === 'Website Lead')
      .map(r => {
        const cf = r.fields || {};
        const companyId = (cf['Company'] || [])[0] || null;
        let cvc = null;
        try { cvc = JSON.parse(cf['AI Summary'] || ''); } catch (e) { cvc = null; }
        return {
          id: r.id,
          fullName: cf['Full Name'] || '',
          companyName: companyId && companiesById[companyId] ? (companiesById[companyId].fields['Company Name'] || '') : '',
          email: cf['Email'] || '',
          cvc
        };
      });

    res.json({ leads });
  } catch (err) {
    console.error('Website leads list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== RESEARCH: EVENT TRANSCRIPTS =====================
// Market Intelligence tab. Uploaded files are read client-side and sent
// here as base64 (same convention as the Sales tab transcript analyzer
// and the Context tab's historical-file upload) - text is extracted
// server-side first (mammoth for .docx, or used as-is for .txt/pasted
// text/.pdf) rather than handed to Claude as a raw document, because the
// Research Events table has a "Raw Transcript" field that needs the
// actual text saved regardless of source format.
//
// PDF text extraction previously went through pdf-parse, but that
// package crashed the Railway deployment on startup, so .pdf uploads now
// fall through to the same plain UTF-8 buffer read as .txt - this reads
// raw PDF bytes rather than real extracted text, so .pdf transcripts will
// come through noisy/unusable until a working PDF text extractor is
// reintroduced.

async function extractTranscriptText(fileBase64, fileMediaType) {
  const buffer = Buffer.from(fileBase64, 'base64');
  if (fileMediaType && fileMediaType.includes('wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  return buffer.toString('utf8');
}

app.post('/api/research/upload-transcript', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { eventName, eventType, date, participantCount, transcript, fileBase64, fileMediaType, fileName } = req.body;
  if (!eventName || !eventType || !date) return res.status(400).json({ error: 'eventName, eventType and date are required' });
  if (!transcript && !fileBase64) return res.status(400).json({ error: 'transcript text or a file is required' });

  try {
    const transcriptText = fileBase64 ? await extractTranscriptText(fileBase64, fileMediaType) : transcript;
    if (!transcriptText || !transcriptText.trim()) return res.status(400).json({ error: 'Could not read any text from that file' });

    const prompt = `You are analysing a transcript from a Twenty2 Collective market research event for T2C Outreach, a LinkedIn outreach CRM for a Perth-based Agile and change consultancy.

Event: "${eventName}" (${eventType}, ${date})

Transcript:
${transcriptText}

Extract from this transcript. Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "themes": string[], "painPoints": string[], "hotTopics": string[], "industries": string[], "sentiment": string }

- themes: 3-6 key themes discussed, each a short phrase.
- painPoints: specific pain points or frustrations participants raised.
- hotTopics: topics that generated the most discussion or interest in the room.
- industries: industries/sectors represented among participants, inferred from context.
- sentiment: one or two sentences on the overall mood/sentiment of the room.

Base everything only on what's actually in the transcript - never invent details. If a category genuinely isn't present, return an empty array for it.`;

    const parsed = await callClaudeJson(prompt, 2000);

    const fields = {
      'Event Name': eventName,
      'Event Type': eventType,
      'Date': date,
      'Raw Transcript': transcriptText,
      'Extracted Themes': (parsed.themes || []).join('\n') + (parsed.sentiment ? `\n\nSentiment: ${parsed.sentiment}` : ''),
      'Key Pain Points': (parsed.painPoints || []).join('\n'),
      'Hot Topics': (parsed.hotTopics || []).join('\n'),
      'Industries Represented': (parsed.industries || []).join('\n'),
      'Source': fileName || 'Pasted transcript'
    };
    if (participantCount) fields['Participant Count'] = participantCount;

    const data = await airtableRequest('POST', 'Research Events', {
      records: [{ fields }],
      typecast: true
    });

    res.json({ success: true, recordId: data.records[0].id, extracted: parsed });
  } catch (err) {
    console.error('Research transcript upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/research/events', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const records = await airtableFetchAllRecords('Research Events');
    const events = records
      .map(r => {
        const f = r.fields || {};
        return {
          id: r.id,
          eventName: f['Event Name'] || '',
          eventType: f['Event Type'] || '',
          date: f['Date'] || '',
          themes: f['Extracted Themes'] || '',
          painPoints: f['Key Pain Points'] || '',
          hotTopics: f['Hot Topics'] || '',
          industries: f['Industries Represented'] || '',
          participantCount: f['Participant Count'] || null,
          source: f['Source'] || ''
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ events });
  } catch (err) {
    console.error('Research events list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aggregates every Research Events record on file and asks Claude to find
// what's recurring across the whole dataset, rather than any one event.
app.get('/api/research/market-pulse', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const records = await airtableFetchAllRecords('Research Events');
    if (!records.length) return res.json({ topPainPoints: [], trendingTopics: [], contentOpportunities: [], eventCount: 0 });

    const eventsContext = records.map(r => {
      const f = r.fields || {};
      return `- "${f['Event Name'] || 'Untitled'}" (${f['Event Type'] || ''}, ${f['Date'] || ''}, ${f['Participant Count'] || '?'} participants)
  Themes: ${f['Extracted Themes'] || 'none'}
  Pain points: ${f['Key Pain Points'] || 'none'}
  Hot topics: ${f['Hot Topics'] || 'none'}
  Industries: ${f['Industries Represented'] || 'none'}`;
    }).join('\n\n');

    const prompt = `You are the market intelligence layer for T2C Outreach, a LinkedIn outreach CRM for Twenty2 Collective, a Perth-based Agile and change consultancy. Below is every market research event logged so far, each already analysed individually.

${eventsContext}

Look across ALL of these events together (not any single one) and return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "topPainPoints": string[], "trendingTopics": string[], "contentOpportunities": string[] }

- topPainPoints: the pain points that recur most across multiple events, ranked by how often/consistently they show up.
- trendingTopics: topics/themes that keep coming up across events, signalling what the WA market is currently focused on.
- contentOpportunities: 3-5 concrete content or campaign ideas Twenty2 Collective could produce, each grounded in a specific recurring pain point or topic from the data above.

Only surface things that genuinely recur across more than one event where possible - call out clearly if something is only from a single event but still notable.`;

    const parsed = await callClaudeJson(prompt, 1800);

    res.json({
      topPainPoints: parsed.topPainPoints || [],
      trendingTopics: parsed.trendingTopics || [],
      contentOpportunities: parsed.contentOpportunities || [],
      eventCount: records.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Market pulse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a company in Airtable, skipping if one with that name already exists
app.post('/api/airtable/company', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  // "Grid Name" is written here (unlike Contacts - see the matching note in
  // POST /api/airtable/contact above) because it's the only way company
  // hydration on load can tell which local grid each company belongs to;
  // there's no other field on this table that carries that. Backfilled onto
  // an existing record too if it's missing there, since companies synced
  // before this field existed would otherwise never pick one up.
  const { name, gridName } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const record = await findOrCreateCompanyRecord(name, gridName);
    res.json({ success: true, skipped: record.skipped, recordId: record.id });
  } catch (err) {
    console.error('Airtable company create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch companies from Airtable - the whole table (for
// hydrateCompaniesFromAirtable's one-time full hydration at app load,
// grouping every record by its "Grid Name" field into the matching local
// grid - see the POST route above), or just one grid's via ?gridName=
// (for hydrateGridCompaniesFromAirtable, re-fetched every time a grid is
// opened so its company list stays current with Airtable rather than
// whatever the app-load hydration happened to have).
app.get('/api/airtable/company', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const gridName = (req.query.gridName || '').trim();
  const sortQs = `sort[0][field]=${encodeURIComponent('Company Name')}&sort[0][direction]=asc`;

  try {
    // airtableFetchAllPaginated, not a single raw fetch - Airtable caps a
    // page at 100 records, and a grid with more companies than that was
    // silently only ever getting the first page. filterByFormula/sort are
    // carried as the extra query string since airtableRequest/
    // airtableFetchAllRecords only take a bare table name.
    if (gridName) {
      // Grid Name is a comma-separated list (see findOrCreateCompanyRecord),
      // so an exact-equals match would miss a company shared with any other
      // grid - wrap both sides in commas and FIND the padded name instead,
      // same "boundary-safe contains" trick as everywhere else in Airtable
      // formulas that need "is one of these list items", not "the whole
      // field equals this one value".
      const formula = `FIND(",${gridName},", "," & SUBSTITUTE({Grid Name}, ", ", ",") & ",") > 0`;
      const filterQs = `filterByFormula=${encodeURIComponent(formula)}&${sortQs}`;
      const records = await airtableFetchAllPaginated('Companies', filterQs);
      return res.json(records);
    }

    const records = await airtableFetchAllPaginated('Companies', sortQs);
    res.json(records);
  } catch (err) {
    console.error('Airtable company list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a company's LinkedIn URL and slug in Airtable
app.patch('/api/airtable/company/linkedin', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { companyName, linkedinUrl, linkedinSlug } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  try {
    const searchRes = await airtableFetchWithRetry(
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
  const { name, goal, product, targetIcp, contactIds, gridIds, sequenceTemplates, strategyNotes, pitchAngle, objectionHandling, successMetric, startDate, status, ctas, contentContext } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const existing = await findCampaignRecordByName(name);

    const strategyNotesParts = [strategyNotes || ''];
    if (pitchAngle) strategyNotesParts.push(`Pitch angle: ${pitchAngle}`);
    if (objectionHandling) strategyNotesParts.push(`Objection handling: ${objectionHandling}`);
    const strategyNotesJoined = strategyNotesParts.filter(Boolean).join('\n\n');

    if (existing) {
      // Only overwrite fields this request actually supplied a non-empty
      // value for - same "don't blank a real field just because this
      // particular write didn't touch it" convention already used by
      // /api/airtable/contact/stage and /api/airtable/company/linkedin
      // below. A blanket overwrite here previously meant any campaign sync
      // (e.g. just editing a sequence stage) would wipe Contact IDs back to
      // empty if state.contacts hadn't finished loading client-side yet.
      const patchFields = {};
      if (goal) patchFields['Goal'] = goal;
      if (product) patchFields['Product'] = product;
      if (targetIcp) patchFields['Target ICP'] = targetIcp;
      if (Array.isArray(contactIds) && contactIds.length) patchFields['Contact IDs'] = contactIds.join(', ');
      if (Array.isArray(gridIds) && gridIds.length) patchFields['Grid IDs'] = gridIds.join(', ');
      if (sequenceTemplates) patchFields['Sequence Templates'] = sequenceTemplates;
      if (strategyNotesJoined) patchFields['Strategy Notes'] = strategyNotesJoined;
      if (successMetric) patchFields['Success Metric'] = successMetric;
      if (startDate) patchFields['Start Date'] = startDate;
      if (status) patchFields['Status'] = status;
      if (ctas) patchFields['CTAs'] = ctas;
      if (contentContext) patchFields['Content Context'] = contentContext;

      if (Object.keys(patchFields).length) {
        await airtableRequest('PATCH', 'Campaigns', { records: [{ id: existing.id, fields: patchFields }] });
      }
      return res.json({ success: true, updated: true, recordId: existing.id });
    }

    const fields = {
      'Name': name,
      'Goal': goal || '',
      'Product': product || '',
      'Target ICP': targetIcp || '',
      'Contact IDs': (contactIds || []).join(', '),
      'Grid IDs': (gridIds || []).join(', '),
      'Sequence Templates': sequenceTemplates || '',
      'Strategy Notes': strategyNotesJoined,
      'Success Metric': successMetric || '',
      'Start Date': startDate || '',
      'Status': status || 'Draft',
      'CTAs': ctas || '',
      'Content Context': contentContext || ''
    };
    const data = await airtableRequest('POST', 'Campaigns', { records: [{ fields }] });
    res.json({ success: true, updated: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable campaign upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch all campaigns from Airtable, for hydrating state.campaigns fresh on
// load instead of caching them in localStorage.
app.get('/api/airtable/campaign', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const records = await airtableFetchAllRecords('Campaigns');
    res.json(records);
  } catch (err) {
    console.error('Airtable campaign list error:', err.message);
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
    const resp = await airtableFetchWithRetry(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
    if (!resp.ok) { const err = await resp.text(); throw new Error(`Airtable error ${resp.status}: ${err}`); }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== GRIDS (shared) =====================
// Grid definitions (name/columns) used to live only in each browser's own
// localStorage - see persistState/loadPersistedState in
// t2c-outreach-crm.html - so two people on two browsers never saw the same
// grid list. This table is the shared source of truth for that now.
// Looked up by the app's own opaque `Grid ID` (a uid('grid') value), not by
// Name, for the same reason findCampaignRecordByName above avoids
// filterByFormula on Campaigns' Name field - a freely-renamed grid could
// contain a double quote and silently break the match.
app.get('/api/airtable/grid', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const records = await airtableFetchAllRecords('Grids');
    res.json(records);
  } catch (err) {
    console.error('Airtable grid list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/airtable/grid', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { gridId, name, columns, createdAt, updatedAt } = req.body;
  if (!gridId) return res.status(400).json({ error: 'gridId is required' });

  try {
    const existing = await findRecordByFieldName('Grids', 'Grid ID', gridId);

    if (existing) {
      // Only include fields this request actually supplied - same "don't
      // blank a real field just because this write didn't touch it"
      // convention as POST /api/airtable/campaign above.
      const patchFields = {};
      if (name) patchFields['Name'] = name;
      if (Array.isArray(columns) && columns.length) patchFields['Columns'] = columns.join(', ');
      if (updatedAt) patchFields['Updated At'] = updatedAt;
      if (Object.keys(patchFields).length) {
        await airtableRequest('PATCH', 'Grids', { records: [{ id: existing.id, fields: patchFields }] });
      }
      return res.json({ success: true, updated: true, recordId: existing.id });
    }

    if (!name) return res.status(400).json({ error: 'name is required to create a grid' });
    const fields = {
      'Grid ID': gridId,
      'Name': name,
      'Columns': (columns || []).join(', '),
      'Created At': createdAt || '',
      'Updated At': updatedAt || createdAt || ''
    };
    const data = await airtableRequest('POST', 'Grids', { records: [{ fields }] });
    res.json({ success: true, updated: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable grid upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/airtable/grid/:gridId', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const gridId = decodeURIComponent(req.params.gridId);

  try {
    const existing = await findRecordByFieldName('Grids', 'Grid ID', gridId);
    if (!existing) return res.json({ success: true, alreadyDeleted: true });

    const url = `${AIRTABLE_URL}/Grids?records[]=${encodeURIComponent(existing.id)}`;
    const resp = await airtableFetchWithRetry(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
    if (!resp.ok) { const err = await resp.text(); throw new Error(`Airtable error ${resp.status}: ${err}`); }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete grid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== SEQUENCES (shared) =====================
// Same "opaque stable ID over display name" lookup convention as Grids
// above - sequence names are freely user-edited (renameSeq) and could
// contain a quote.
app.get('/api/airtable/sequence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const records = await airtableFetchAllRecords('Sequences');
    res.json(records);
  } catch (err) {
    console.error('Airtable sequence list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/airtable/sequence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { sequenceId, name, roles, voice, connect, m1, m2, cta } = req.body;
  if (!sequenceId) return res.status(400).json({ error: 'sequenceId is required' });

  try {
    const existing = await findRecordByFieldName('Sequences', 'Sequence ID', sequenceId);

    if (existing) {
      const patchFields = {};
      if (name) patchFields['Name'] = name;
      if (Array.isArray(roles) && roles.length) patchFields['Roles'] = roles.join(', ');
      if (voice) patchFields['Voice'] = voice;
      if (connect) patchFields['Connect Template'] = connect;
      if (m1) patchFields['Message 1 Template'] = m1;
      if (m2) patchFields['Message 2 Template'] = m2;
      if (cta) patchFields['CTA Template'] = cta;
      if (Object.keys(patchFields).length) {
        await airtableRequest('PATCH', 'Sequences', { records: [{ id: existing.id, fields: patchFields }] });
      }
      return res.json({ success: true, updated: true, recordId: existing.id });
    }

    if (!name) return res.status(400).json({ error: 'name is required to create a sequence' });
    const fields = {
      'Sequence ID': sequenceId,
      'Name': name,
      'Roles': (roles || []).join(', '),
      'Voice': voice || '',
      'Connect Template': connect || '',
      'Message 1 Template': m1 || '',
      'Message 2 Template': m2 || '',
      'CTA Template': cta || ''
    };
    const data = await airtableRequest('POST', 'Sequences', { records: [{ fields }] });
    res.json({ success: true, updated: false, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable sequence upsert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== BOOKINGS (shared) =====================
// Always a create - the app never edits a booking in place today (only
// ever pushes new ones from confirmBooking), so there's no upsert-by-key
// need the way Grids/Sequences/Campaigns have.
app.get('/api/airtable/booking', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const records = await airtableFetchAllRecords('Bookings');
    res.json(records);
  } catch (err) {
    console.error('Airtable booking list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/airtable/booking', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { contactName, company, service, date, cta, notes } = req.body;
  if (!contactName || !company) return res.status(400).json({ error: 'contactName and company are required' });

  try {
    const fields = {
      'Contact Name': contactName,
      'Company': company,
      'Service': service || '',
      'Date': date || '',
      'CTA': cta || '',
      'Notes': notes || ''
    };
    const data = await airtableRequest('POST', 'Bookings', { records: [{ fields }] });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable booking create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== DEAD CONTACTS (shared) =====================
app.get('/api/airtable/dead-contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const records = await airtableFetchAllRecords('Dead Contacts');
    res.json(records);
  } catch (err) {
    console.error('Airtable dead contact list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/airtable/dead-contact', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { name, company, role, days, removed } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company are required' });

  try {
    const fields = {
      'Name': name,
      'Company': company,
      'Role': role || '',
      'Days': typeof days === 'number' ? days : 0,
      'Removed': removed || ''
    };
    const data = await airtableRequest('POST', 'Dead Contacts', { records: [{ fields }] });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable dead contact create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== ACTIVITY (shared, write-only) =====================
// No GET route - nothing in the app renders an activity feed today (6
// scattered .unshift() call sites write it, nothing reads it back). This
// just gives those existing writes a shared home instead of each browser's
// own localStorage, per the locked "migrate as-is, write-only" decision.
app.post('/api/airtable/activity', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { type, text, date } = req.body;
  if (!type || !text) return res.status(400).json({ error: 'type and text are required' });

  try {
    const fields = { 'Type': type, 'Text': text, 'Date': date || '' };
    const data = await airtableRequest('POST', 'Activity', { records: [{ fields }] });
    res.json({ success: true, recordId: data.records[0].id });
  } catch (err) {
    console.error('Airtable activity create error:', err.message);
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

  const { contactName, contactNames, contactRecordIds, date, type, notes, outcome, communicationMethod, aiBrief, campaignId, campaignName, repId } = req.body;
  if (!type) return res.status(400).json({ error: 'type is required' });

  try {
    let contactIds = [];
    // Names resolved alongside ids either way - needed below to build the
    // "[Type] - [Contact Name] - [Date]" Name field, not just for the
    // Contact link itself.
    let resolvedNames = [];
    if (Array.isArray(contactRecordIds) && contactRecordIds.length) {
      contactIds = contactRecordIds;
      const contactRecords = await Promise.all(contactIds.map(id => airtableGetRecord('Contacts', id)));
      resolvedNames = contactRecords.filter(Boolean).map(r => r.fields['Full Name'] || '').filter(Boolean);
    } else {
      const names = (Array.isArray(contactNames) && contactNames.length) ? contactNames : (contactName ? [contactName] : []);
      if (!names.length) return res.status(400).json({ error: 'contactName(s) or contactRecordIds are required' });
      const records = await Promise.all(names.map(n => findRecordByFieldName('Contacts', 'Full Name', n)));
      contactIds = records.filter(Boolean).map(r => r.id);
      resolvedNames = names;
    }

    const dateValue = date || new Date().toISOString().slice(0, 10);
    const summary = campaignName ? `[Campaign: ${campaignName}] ${notes || ''}`.trim() : (notes || '');
    const fields = {
      'Name': `${type} - ${resolvedNames.length ? resolvedNames.join(', ') : 'Unknown contact'} - ${dateValue}`,
      'Date': dateValue,
      'Type': type,
      'Summary': summary,
      'Outcome': outcome || 'No reply',
      'Direction': 'Outbound'
    };
    if (communicationMethod) fields['Communication Method'] = communicationMethod;
    if (aiBrief) fields['Outreach Brief'] = aiBrief;
    if (contactIds.length) fields['Contact'] = contactIds;

    // typecast:true lets new Type values (e.g. from the Logger tab's wider
    // touch point type list) create themselves as select options instead of
    // erroring - same as the typecast:true POST to this table already used
    // by POST /api/context/parse-screenshot below.
    const data = await airtableRequest('POST', 'Touch Points', { records: [{ fields }], typecast: true });
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

    // Best-effort, same reasoning as the Campaign tag write above - the real
    // Touch Points table's exact field set isn't confirmed to include a Rep
    // link, so this never blocks the primary save if it doesn't exist.
    if (repId) {
      try {
        await airtableRequest('PATCH', 'Touch Points', { records: [{ id: recordId, fields: { 'Rep': [repId] } }] });
      } catch (repErr) {
        console.warn('Best-effort Rep field write on Touch Points failed:', repErr.message);
      }
    }

    res.json({ success: true, recordId });
    detectContentSignals().catch(err => console.warn('Content signal detection trigger failed:', err.message));
  } catch (err) {
    console.error('Airtable touch point error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch all touch points from Airtable, for hydrating each contact's
// touchPoints array fresh on load instead of caching them in localStorage.
app.get('/api/airtable/touchpoint', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const records = await airtableFetchAllRecords('Touch Points');
    res.json(records);
  } catch (err) {
    console.error('Airtable touch point list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Logger tab (main nav) - reads a pasted LinkedIn message/conversation or a
// screenshot of one and extracts a summary, sentiment, objections and next
// steps, for the rep to review/edit before saving the touch point. Same
// Claude Vision pattern as POST /api/context/parse-connections-screenshot
// above, but this one has no Airtable side effects of its own - the contact
// is already chosen by the rep in the Logger UI (unlike parse-screenshot,
// which has to identify the contact from the screenshot itself), and saving
// the resulting touch point goes through the existing POST
// /api/airtable/touchpoint route instead of writing anything here.
// System prompt is kept separate from the extraction instructions below so
// the "return only JSON, exactly this shape" rule reads as a hard format
// constraint rather than one more bullet Claude might drop under load - the
// explicit example gives it a concrete shape to pattern-match against
// instead of just a schema description.
const LOGGER_PARSE_CONVERSATION_SYSTEM = `You extract structured data from a LinkedIn conversation for a sales CRM. Respond with ONLY a single JSON object - no preamble, no commentary, no markdown code fences, and no fields beyond the ones described. Example of the exact shape to return:
{ "summary": "Discussed pricing for the Change Value Check offer; contact was receptive but wants board sign-off.", "sentiment": "Positive", "objections": "Needs board approval before committing.", "nextSteps": "Send a proposal by Friday." }`;

const LOGGER_FRIENDLY_PARSE_ERROR = "We couldn't read that — try rewording or breaking it into shorter entries";

app.post('/api/logger/parse-conversation', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, text } = req.body || {};
  if (!image && !text) return res.status(400).json({ error: 'image or text is required' });

  const prompt = `You are reading a LinkedIn message or conversation for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM. A sales rep is logging it as a touch point against a contact they've already selected.

${text ? `Here is the pasted conversation text:\n${text}` : 'Read the attached screenshot of the conversation.'}

Extract:
- summary: a concise 2-3 sentence summary of what was discussed.
- sentiment: the sentiment of the contact's side of the conversation, exactly one of "Positive", "Neutral", "Negative" if they have replied. If there's no reply from them yet (only outbound messages), set this to null.
- objections: any objections or concerns they raised, in their own words where possible. Empty string if none.
- nextSteps: any next steps agreed or implied. Empty string if none.`;

  const content = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: prompt }
      ]
    : prompt;

  // Every failure mode here - Claude API error, a fence/preamble it ignored
  // the system prompt about, malformed JSON, or valid JSON in the wrong
  // shape - collapses to the same safe { error: true, message } object
  // rather than a 500, so the frontend can show one friendly inline message
  // instead of a crash or a generic toast.
  try {
    const raw = await callClaudeMessages(content, 600, LOGGER_PARSE_CONVERSATION_SYSTEM);

    let parsed;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch (parseErr) {
      console.error('Logger parse-conversation: malformed JSON from Claude:', raw);
      return res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Logger parse-conversation: unexpected structure from Claude:', parsed);
      return res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
    }

    res.json({
      success: true,
      summary: parsed.summary || '',
      sentiment: parsed.sentiment || null,
      objections: parsed.objections || '',
      nextSteps: parsed.nextSteps || ''
    });
  } catch (err) {
    console.error('Logger parse-conversation error:', err.message);
    res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
  }
});

// Logger tab's "AI Assistant" mode - a rep dumps a free-text summary of
// several unrelated interactions in one go (or a screenshot covering more
// than one), and this splits it into individual touch point candidates for
// review. Deliberately a separate route from POST /api/logger/parse-
// conversation above, which is scoped to one already-selected contact's
// single conversation and returns a different shape (summary/sentiment/
// objections/nextSteps) - reusing that name here would have broken the
// existing manual "LinkedIn Message"/"LinkedIn Conversation" touch point
// types, which already call it. This route has no Airtable side effects of
// its own either; matching/creating the contact and saving each confirmed
// touch point happens client-side against the existing POST /api/airtable/
// contact and POST /api/airtable/touchpoint routes, same as manual mode.
const LOGGER_EXTRACT_TYPES = ['LinkedIn Message', 'LinkedIn Conversation', 'Call', 'Meeting', 'Sales Proposal', 'Research', 'Email', 'Inbound Lead', 'Event'];

app.post('/api/logger/extract-touchpoints', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, text } = req.body || {};
  if (!image && !text) return res.status(400).json({ error: 'image or text is required' });

  const today = new Date().toISOString().slice(0, 10);

  // Bare JSON array, not the previous { touchPoints: [...] } wrapper - one
  // less shape for Claude to drift from, and the explicit example below
  // gives it something concrete to match rather than just a schema.
  const system = `You extract touch points from a sales rep's free-text activity dump for a CRM. Respond with ONLY a JSON array - no preamble, no commentary, no markdown code fences, no wrapping object, and no fields beyond the ones described. Example of the exact shape to return:
[ { "contactName": "Craig Humphrey", "company": "BHP", "type": "Call", "summary": "Caught up on the Q3 roadmap.", "date": "${today}" } ]`;

  const prompt = `You are reading a free-text dump from a sales rep at T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM, summarising several interactions from their day in one go - e.g. "Had a call with Stuart at Woodside, sent a LinkedIn message to Craig at BHP, met Elle at a networking event".

${text ? `Here is the dump:\n${text}` : 'Read the attached screenshot, which may cover more than one interaction.'}

Extract every distinct touch point mentioned. For each one:
- contactName: the person's name as given (a first name alone is fine if that's all that's mentioned).
- company: their company, if mentioned. Empty string if not.
- type: exactly one of ${LOGGER_EXTRACT_TYPES.map(t => `"${t}"`).join(', ')} - whichever best matches what's described.
- summary: a concise one-sentence summary of what happened.
- date: in YYYY-MM-DD format. Today's date is ${today}. Resolve any relative date mentioned (e.g. "yesterday", "Tuesday") against today; if no date is mentioned at all, use today's date.`;

  const content = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: prompt }
      ]
    : prompt;

  try {
    const raw = await callClaudeMessages(content, 1200, system);

    let parsedArray;
    try {
      parsedArray = JSON.parse(stripCodeFences(raw));
    } catch (parseErr) {
      console.error('Logger extract-touchpoints: malformed JSON from Claude:', raw);
      return res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
    }
    if (!Array.isArray(parsedArray)) {
      console.error('Logger extract-touchpoints: unexpected structure from Claude:', parsedArray);
      return res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
    }

    const touchPoints = parsedArray
      .filter(t => t && t.contactName)
      .map(t => ({
        contactName: String(t.contactName).trim(),
        company: t.company ? String(t.company).trim() : '',
        type: LOGGER_EXTRACT_TYPES.includes(t.type) ? t.type : 'Call',
        summary: t.summary ? String(t.summary).trim() : '',
        date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : today
      }));

    res.json({ success: true, touchPoints });
  } catch (err) {
    console.error('Logger extract-touchpoints error:', err.message);
    res.json({ error: true, message: LOGGER_FRIENDLY_PARSE_ERROR });
  }
});

// Logger tab's post-create "Add to campaign" step - offered right after a
// brand new contact is added inline, so a rep who's just met someone can
// enrol them in a campaign immediately instead of doing it later from the
// campaign's own Roadmap tab. Kept as its own route rather than reusing
// POST /api/campaign/:id/contacts/link, which several other callers
// already rely on always defaulting a new row to "Found" - this one needs
// to honour whichever of the 3 stages the rep picked.
// "Connection Made" maps to the Sequence Stage vocabulary's "Connected" so
// the created row stays readable by every other Sequence-Stage-aware
// feature (Today's Actions, funnel counts, etc.) rather than introducing a
// stage value nothing else recognises.
const LOGGER_JOURNEY_STAGE_TO_SEQUENCE_STAGE = {
  'Found': 'Found',
  'Connection Pending': 'Connection Pending',
  'Connection Made': 'Connected'
};

app.post('/api/logger/add-to-campaign', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactId, campaignId, stage } = req.body || {};
  if (!contactId || !campaignId || !stage) return res.status(400).json({ error: 'contactId, campaignId and stage are required' });
  const sequenceStage = LOGGER_JOURNEY_STAGE_TO_SEQUENCE_STAGE[stage];
  if (!sequenceStage) return res.status(400).json({ error: 'stage must be Found, Connection Pending or Connection Made' });

  try {
    const [contactRecord, campaignRecord, rows] = await Promise.all([
      airtableGetRecord('Contacts', contactId),
      airtableGetRecord('Campaigns', campaignId),
      fetchCampaignContactsRows()
    ]);
    if (!contactRecord) return res.json({ success: false, reason: 'Contact not found in Airtable' });
    if (!campaignRecord) return res.json({ success: false, reason: 'Campaign not found in Airtable' });

    const contactName = contactRecord.fields['Full Name'] || '';
    const campaignName = campaignRecord.fields['Name'] || '';
    const dateLabel = new Date().toISOString().slice(0, 10);

    const existing = findCampaignContactRow(rows, contactId, campaignId);
    let recordId;
    if (existing) {
      await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, {
        records: [{
          id: existing.id,
          fields: {
            'Sequence Stage': sequenceStage,
            'Stage History': appendStageHistory(existing.fields['Stage History'], sequenceStage, dateLabel)
          }
        }]
      });
      recordId = existing.id;
    } else {
      const created = await getOrCreateCampaignContactRow(contactId, contactName, campaignId, campaignName, rows, {
        'Sequence Stage': sequenceStage,
        'Stage History': appendStageHistory('', sequenceStage, dateLabel)
      });
      recordId = created.id;
    }

    res.json({ success: true, recordId });
  } catch (err) {
    console.error('Logger add-to-campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a contact's journey stage
app.patch('/api/airtable/contact/stage', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactName, company, state: contactState, nextTouchDate, painPoints } = req.body;
  if (!contactName) return res.status(400).json({ error: 'contactName is required' });

  try {
    const searchRes = await airtableFetchWithRetry(
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
    'found': 'Found',
    'opened': 'Found',
    'connected': 'Connected',
    'messaging': 'Messaging',
    'booked': 'Booked'
  };
  return map[state] || 'Found';
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
        const searchRes = await airtableFetchWithRetry(
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
    const records = await airtableFetchAllRecords('Learning Data');
    return records.map(r => ({
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

// Website Lead contacts (see POST /api/leads/website) carry a Change Value
// Check report as a JSON string in AI Summary instead of free-text notes.
// Pulls those out and renders a full per-contact breakdown - archetype, all
// four pillar scores, both leaks and the three insight titles - so the
// intelligence prompt can pitch message drafts/suggestions at their actual
// CVC report rather than generic outreach.
function cvcProfilesContext(contactRecords) {
  const lines = contactRecords
    .filter(r => r.fields['Journey Stage'] === 'Website Lead')
    .map(r => {
      let cvc;
      try { cvc = JSON.parse(r.fields['AI Summary'] || ''); } catch (e) { return null; }
      if (!cvc || !cvc.archetype) return null;
      const insightTitles = (cvc.insights || []).map(i => i && i.title).filter(Boolean);
      return `- ${r.fields['Full Name'] || 'Unknown'}: archetype "${cvc.archetype}". Pillar scores - overall ${cvc.overallScore}/100, people ${cvc.peopleScore}/100, productivity ${cvc.productivityScore}/100, performance ${cvc.performanceScore}/100. Primary leak "${cvc.primaryLeak}", secondary leak "${cvc.secondaryLeak}". Report insights: ${insightTitles.length ? insightTitles.map(t => `"${t}"`).join(', ') : 'none recorded'}.`;
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : 'No Website Lead contacts with a Change Value Check report on file yet.';
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
    const records = await airtableFetchAllRecords('Conversions');
    return records.map(r => ({
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
    const records = await airtableFetchAllRecords('Campaigns');
    return records.map(r => ({
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
    const [contactRecords, touchPointRecords, campaigns] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      fetchCampaigns()
    ]);

    const contacts = contactRecords.map(r => ({
      journeyStage: r.fields['Journey Stage'] || ''
    }));
    const touchPoints = touchPointRecords.map(r => ({
      date: r.fields['Date'] || ''
    }));

    res.json(computeEngineHealth(contacts, touchPoints, campaigns));
  } catch (err) {
    console.error('Intelligence health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Run Engine" pipeline strategy analysis (Home tab) - takes the same
// engineHealth (GET /api/intelligence/health) and insights (GET
// /api/track/insights) payloads the client already fetches for the other
// three Run Engine steps, and asks Claude for a wins/gaps/losses/
// recommendations read. Moved server-side from a direct, key-less browser
// call to api.anthropic.com that always failed to its local fallback.
app.post('/api/intelligence/strategy-analysis', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { engineHealth, insights } = req.body || {};
  if (!engineHealth || !insights) return res.status(400).json({ error: 'engineHealth and insights are required' });

  try {
    const stageBreakdown = (engineHealth.contactsByStage || []).map(s => `${s.stage}: ${s.count}`).join(', ') || 'none on file';
    const topRoles = (insights.topIcpRoles || []).join('; ') || 'none logged yet';
    const topProducts = (insights.topProducts || []).join('; ') || 'none logged yet';
    const topMethods = (insights.topMethods || []).join('; ') || 'none logged yet';

    const prompt = `Analyse this LinkedIn outreach pipeline for a Perth Agile/change consultancy, using live data synced from Airtable.\n\nNumeric data: ${engineHealth.totalContacts ?? 0} total contacts, ${engineHealth.touchPointsThisWeek ?? 0} touch points logged this week, ${engineHealth.activeCampaigns ?? 0} active campaigns, ${engineHealth.overallConversionRate ?? 0}% overall conversion rate, ${insights.conversionCount ?? 0} conversions logged.\nContacts by journey stage: ${stageBreakdown}.\nTop converting ICP roles: ${topRoles}.\nTop converting products: ${topProducts}.\nTop converting communication methods: ${topMethods}.\nAverage touch points to convert: ${insights.avgTouchPoints ?? 'not enough data'}.\n\nReturn ONLY valid JSON in this exact shape: {"wins": string[], "gaps": string[], "losses": string[], "recommendations": string[]}. 2-4 items per array, each a single short sentence, no markdown.`;

    const parsed = await callClaudeJson(prompt, 1000);
    res.json({
      success: true,
      wins: Array.isArray(parsed.wins) ? parsed.wins : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      losses: Array.isArray(parsed.losses) ? parsed.losses : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : []
    });
  } catch (err) {
    console.error('Strategy analysis error:', err.message);
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

// Real sales call feedback (script adherence, objections, CTAs actually
// used), written by POST /api/campaign/:id/sales/analyze-transcript. Table
// may not exist in every base yet, so failures are swallowed like Learning
// Data/Conversions.
async function fetchSalesLog() {
  try {
    const records = await airtableFetchAllRecords('Sales Log');
    return records.map(r => ({
      campaign: r.fields['Campaign'] || '',
      type: r.fields['Type'] || '',
      scriptAdherence: r.fields['Script Adherence'] || '',
      notes: r.fields['Notes'] || '',
      ctasUsed: r.fields['CTAs Used'] || '',
      objectionsRaised: r.fields['Objections Raised'] || '',
      date: r.fields['Date'] || ''
    }));
  } catch (err) {
    console.warn('Could not fetch Sales Log (table may not exist yet):', err.message);
    return [];
  }
}

// Real LinkedIn post engagement data, synced from Trigify by the "Marcus
// content analysis" job and written to the Content Performance table.
async function fetchContentPerformance() {
  try {
    const records = await airtableFetchAllRecords('Content Performance');
    return records.map(r => ({
      date: r.fields['Date'] || '',
      likes: r.fields['Likes'] || 0,
      comments: r.fields['Comments'] || 0,
      engagementScore: r.fields['Engagement Score'] || 0,
      topic: r.fields['Topic'] || '',
      format: r.fields['Format'] || '',
      ctaUsed: r.fields['CTA Used'] || '',
      whatWorked: r.fields['What Worked'] || ''
    }));
  } catch (err) {
    console.warn('Could not fetch Content Performance (table may not exist yet):', err.message);
    return [];
  }
}

function salesLogContext(salesLog) {
  if (!salesLog.length) return 'No sales call transcripts analysed yet.';
  const objectionCounts = rankCounts(
    salesLog.flatMap(s => (s.objectionsRaised || '').split(',').map(o => o.trim()).filter(Boolean)),
    o => o
  ).slice(0, 5).map(([o, count]) => `${o} (${count}x)`);
  const calls = salesLog.map(s => `- [${s.date}, ${s.campaign || 'no campaign'}] Script adherence: ${s.scriptAdherence || 'not scored'}. CTAs used: ${s.ctasUsed || 'none recorded'}. Objections: ${s.objectionsRaised || 'none recorded'}.`).join('\n');
  return calls + (objectionCounts.length ? `\n\nMost common objections raised across all calls: ${objectionCounts.join(', ')}.` : '');
}

function contentPerformanceContext(contentPerformance) {
  if (!contentPerformance.length) return 'No LinkedIn post performance data on file yet.';
  const byFormat = {};
  contentPerformance.forEach(p => {
    const key = p.format || 'Unknown format';
    if (!byFormat[key]) byFormat[key] = [];
    byFormat[key].push(p.engagementScore || 0);
  });
  const topFormats = Object.entries(byFormat)
    .map(([format, scores]) => [format, Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 10) / 10, scores.length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([format, avg, count]) => `${format}: avg engagement score ${avg} across ${count} post${count === 1 ? '' : 's'}`);
  return `Top performing post formats by average engagement score (likes + comments): ${topFormats.join('; ') || 'not enough data'}.`;
}

app.post('/api/intelligence', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const [contactRecords, touchPointRecords, learningData, conversions, campaigns, salesLog, contentPerformance] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      fetchLearningData(),
      fetchConversions(),
      fetchCampaigns(),
      fetchSalesLog(),
      fetchContentPerformance()
    ]);
    // Note: there is no "Signals" table or concept anywhere in this app's
    // schema yet, so there is nothing to fetch for it - not fabricating one.

    const contacts = contactRecords.map(r => ({
      id: r.id,
      name: r.fields['Full Name'] || '',
      company: r.fields['Company'] || '',
      role: r.fields['Job Title'] || '',
      icpRoleCategory: r.fields['ICP Role Category'] || '',
      journeyStage: r.fields['Journey Stage'] || '',
      linkedinUrl: r.fields['LinkedIn URL'] || '',
      notes: r.fields['Notes'] || ''
    }));

    const touchPoints = touchPointRecords.map(r => ({
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

WEBSITE LEAD PROFILES - Change Value Check reports for contacts who came in via the website (use the full breakdown - archetype, all four pillar scores, both leaks and the report's insight titles - to calibrate campaignSuggestions and messageDrafts for these specific contacts, rather than generic messaging). Primary leak maps to T2C's service offerings: a people leak maps to People Capability, a productivity leak maps to Operational Excellence, and a performance leak maps to Strategy and Governance - use this mapping to recommend the most relevant T2C product for each contact and tailor their message draft's outreach angle around that specific service and leak, not a generic pitch:
${cvcProfilesContext(contactRecords)}

SALES CALL FEEDBACK - script adherence, objections raised and CTAs actually used, scored from real call transcripts (${salesLog.length} on file - use this to sharpen objection-handling and pitch-angle suggestions with what's actually happening on calls, not theory):
${salesLogContext(salesLog)}

CONTENT PERFORMANCE - real engagement data from Marcus's LinkedIn posts (${contentPerformance.length} posts analysed - use this to inform which angles and formats are resonating when suggesting message angles or content-driven campaigns):
${contentPerformanceContext(contentPerformance)}

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
- messageDrafts: 2-4 ready-to-send message drafts for specific contacts who look due for a follow-up. UK English, no em dashes, peer to peer tone, one observation and one question, 3-4 sentences, signed off "Twenty2 Collective". For a Website Lead contact with a CVC report, use their primary leak's mapped T2C product (per the mapping above) to pick the outreach angle and reference their specific archetype/leak rather than writing a generic message.
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

// Shared research call - two Serper searches (profile + general/news) fed to
// Claude for synthesis. Used by both the grid card's Enrich button (POST
// /api/enrich/contact) and the contact drawer's Enrich button (POST
// /api/contacts/enrich), which previously duplicated this near-identical
// logic with two different output shapes and only one of them (the drawer)
// actually persisted successfully.
async function researchContactEnrichment(name, company, linkedinUrl) {
  const slug = extractLinkedInSlug(linkedinUrl || '');
  const [profileSearch, newsSearch] = await Promise.all([
    // "Australia" only added to the name-fallback query (no slug yet) -
    // pointless noise on a site:linkedin.com/in/<slug> exact-URL lookup,
    // which is already unambiguous. gl:'au' and location:'Australia' are
    // applied either way, same AU bias as searchContactViaSerper above,
    // since it's harmless even on an exact-slug lookup.
    fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: slug ? `site:linkedin.com/in/${slug}` : `${name} LinkedIn Australia`, gl: 'au', location: 'Australia' })
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

Contact: ${name}${company ? ' at ' + company : ''}.${linkedinUrl ? `\nLinkedIn: ${linkedinUrl}` : ''}

Search results for their LinkedIn profile${slug ? ` (site:linkedin.com/in/${slug})` : ''}:
${profileResults || 'No results found.'}

Search results for "${name} ${company || ''}" (news, interviews, speaking events):
${newsResults || 'No results found.'}

Based only on the above, return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{
  "currentTitle": string,
  "company": string,
  "workHistory": string,
  "education": string,
  "location": string,
  "bio": string,
  "recentActivity": string,
  "likelyPainPoints": string,
  "bestOutreachAngle": string
}

"workHistory" is a short summary of previous roles/companies if findable. "education" and "location" should each be one line. If the search results do not give enough to fill a field confidently, say so plainly in that field (e.g. "Not enough public information found") rather than inventing detail.`;

  const profile = await callClaudeJson(prompt, 1200);
  profile.date = new Date().toISOString().slice(0, 10);
  return profile;
}

// The enrichment profile is persisted as a single JSON block prepended to
// Contacts.AI Summary (there's no dedicated enrichment field on the real
// table, and past instruction was not to add one) - stripped and replaced
// on every re-enrich rather than accumulating, so the field always carries
// at most one enrichment block plus whatever narrative text (notes summaries
// etc.) already lived there. Skips the write entirely for a Website Lead
// contact, whose AI Summary field is a single Change Value Check JSON blob
// (see POST /api/leads/website) that a prepended block would corrupt.
const ENRICHMENT_BLOCK_RE = /^ENRICHMENT_JSON:\s*(\{[\s\S]*?\})\n\n/;

function parseContactEnrichment(aiSummaryText) {
  const m = (aiSummaryText || '').match(ENRICHMENT_BLOCK_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function stripContactEnrichmentBlock(aiSummaryText) {
  return (aiSummaryText || '').replace(ENRICHMENT_BLOCK_RE, '');
}

async function persistContactEnrichment(contactRecord, profile) {
  const existing = contactRecord.fields['AI Summary'] || '';
  let cvc = null;
  try { cvc = JSON.parse(existing); } catch (e) { /* not JSON - plain narrative text, fine to prepend to */ }
  if (cvc && cvc.archetype) {
    console.warn(`Skipping enrichment write for contact ${contactRecord.id} - AI Summary holds Change Value Check data`);
    return;
  }
  const newSummary = `ENRICHMENT_JSON: ${JSON.stringify(profile)}\n\n${stripContactEnrichmentBlock(existing)}`;
  await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactRecord.id, fields: { 'AI Summary': newSummary } }] });
}

app.post('/api/enrich/contact', async (req, res) => {
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { linkedinUrl, name, company } = req.body;
  if (!linkedinUrl || !name) return res.status(400).json({ error: 'linkedinUrl and name are required' });
  if (!extractLinkedInSlug(linkedinUrl)) return res.status(400).json({ error: 'Could not parse a LinkedIn slug from that URL' });

  try {
    const profile = await researchContactEnrichment(name, company, linkedinUrl);

    // Store back onto the Airtable Contact record immediately so the
    // profile persists across page loads and other views. Non-fatal if
    // this fails - the enrichment itself already succeeded and should
    // still reach the client.
    try {
      const contactRecord = await findRecordByFieldName('Contacts', 'Full Name', name);
      if (contactRecord) await persistContactEnrichment(contactRecord, profile);
    } catch (airtableErr) {
      console.warn('Could not store enrichment profile to Airtable:', airtableErr.message);
    }

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Enrichment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== APOLLO.IO =====================
// Grid toolbar's "Search Apollo" modal - a prospecting search distinct from
// the Serper-based searchContactViaSerper above (which finds one named
// person at one named company). This searches broadly across Apollo's
// database by job title / location / industry keywords and returns
// candidates to review before importing.

app.post('/api/apollo/search-contacts', async (req, res) => {
  if (!process.env.APOLLO_API_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY not configured' });

  const { jobTitle, location, keywords } = req.body || {};
  if (!jobTitle && !location && !keywords) {
    return res.status(400).json({ error: 'jobTitle, location or keywords is required' });
  }

  // Job titles accept a comma-separated list - Apollo's person_titles param
  // is an array, matched as OR within the field.
  const splitList = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

  // Locations use semicolons instead, since a single location is itself
  // often a comma-separated "City, Country" string (e.g. "Perth,
  // Australia") - comma-splitting would break that one location into two
  // fragments. Semicolons let multiple full locations be listed together,
  // e.g. "Perth, Australia; Sydney, Australia" -> ["Perth, Australia",
  // "Sydney, Australia"], matching Apollo's person_locations array as
  // intended (one full location string per entry) instead of over-splitting.
  const splitLocations = v => (v || '').split(';').map(s => s.trim()).filter(Boolean);

  try {
    const apolloBody = { per_page: 100 };
    const titles = splitList(jobTitle);
    const locations = splitLocations(location);
    const keywordTags = splitList(keywords);
    if (titles.length) apolloBody.person_titles = titles;
    if (locations.length) apolloBody.person_locations = locations;
    // Sent as separate array entries (OR'd by Apollo) rather than one
    // q_keywords string, which Apollo would otherwise treat as a single
    // phrase to match rather than a set of alternative industry keywords.
    if (keywordTags.length) apolloBody['organization_keyword_tags[]'] = keywordTags;

    // Apollo caps a single page at 100 results and reports how many pages
    // exist via response.pagination.total_pages - walked here the same way
    // airtableFetchAllPaginated walks Airtable's offset cursor, so a broad
    // search doesn't silently truncate at the first page. MAX_PAGES is a
    // sane cap (2,000 results) against a pathologically broad search
    // hammering Apollo's API indefinitely, not a limit expected to be hit
    // in normal use.
    const MAX_PAGES = 20;
    let people = [];
    let page = 1;
    let totalPages = 1;
    do {
      const apolloRes = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.APOLLO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ ...apolloBody, page })
      });

      if (!apolloRes.ok) {
        const errText = await apolloRes.text();
        throw new Error(`Apollo API error ${apolloRes.status}: ${errText}`);
      }

      const data = await apolloRes.json();
      people = people.concat(data.people || []);
      // Falls back to computing pages from total_entries when total_pages
      // itself is missing/zero on a given response - belt-and-braces in
      // case a particular account/plan's response omits one but not the
      // other, so a present total_entries alone still doesn't leave this
      // stuck reporting 1 page forever.
      const pagination = data.pagination || {};
      totalPages = pagination.total_pages
        || (pagination.total_entries ? Math.ceil(pagination.total_entries / (apolloBody.per_page || 100)) : 1);
      console.log(`Apollo search page ${page}/${totalPages} - ${(data.people || []).length} people this page, pagination: ${JSON.stringify(pagination)}`);
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    // linkedin_url comes straight off each person's free profile fields
    // returned by the plain search call - email/phone are deliberately
    // never read here, since revealing those on Apollo requires a separate
    // paid "match"/enrich call this route never makes. The search response
    // splits the name across first_name and last_name_obfuscated (rather
    // than a single last_name) - combined here into one display name, with
    // p.name/p.last_name as a fallback for whichever shape a given result
    // actually comes back in.
    const results = people
      .map(p => ({
        name: [p.first_name, p.last_name_obfuscated || p.last_name].filter(Boolean).join(' ').trim() || p.name || '',
        jobTitle: p.title || '',
        company: (p.organization && p.organization.name) || p.organization_name || '',
        linkedinUrl: p.linkedin_url || ''
      }))
      .filter(r => r.name);

    res.json({ success: true, results });
  } catch (err) {
    console.error('Apollo search-contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== CAMPAIGN CHAT + BUILD =====================
// Free-form campaign setup. /chat carries the conversation forward one turn
// at a time, grounded in real Airtable data, until Claude has enough to
// build the campaign. /build then does the heavier work of matching
// contacts and drafting the sequence from the full conversation.

async function fetchCampaignContext() {
  const [contactRecords, touchPointRecords] = await Promise.all([
    airtableFetchAllRecords('Contacts'),
    airtableFetchAllRecords('Touch Points')
  ]);

  const contacts = contactRecords.map(r => ({
    name: r.fields['Full Name'] || '',
    company: Array.isArray(r.fields['Company']) ? '' : (r.fields['Company'] || ''),
    role: r.fields['Job Title'] || '',
    journeyStage: r.fields['Journey Stage'] || '',
    notes: r.fields['Notes'] || ''
  })).filter(c => c.name);

  const touchPoints = touchPointRecords.map(r => ({
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
- sequence: three outreach stages. "type" is one of "LinkedIn message", "Email", "Call" - pick whatever fits the conversation, default to "LinkedIn message" if nothing was specified. If an existing strategy/script was mentioned in the conversation, adapt it rather than starting from scratch. Otherwise write fresh copy. UK English, no em dashes, peer to peer tone, one observation and one question per message, 3-4 sentences, signed off "Twenty2 Collective". "timing" is when to send relative to the previous step, e.g. "Day 0", "3 days after message 1", "7 days after follow-up 1".
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

// Strategy tab "Engine redraft" on a sequence stage (aiRedraftSequenceStage
// in t2c-outreach-crm.html) - the campaign object here is whatever the
// client currently holds in local state (possibly not yet saved to
// Airtable), so this takes it as-is in the body rather than looking a
// record up by id.
app.post('/api/campaign/redraft-stage', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { campaign, stageLabel, currentType, currentContent, historicalNote } = req.body || {};
  if (!campaign || !campaign.name) return res.status(400).json({ error: 'campaign.name is required' });
  if (!stageLabel) return res.status(400).json({ error: 'stageLabel is required' });

  try {
    const prompt = `You are redrafting the "${stageLabel}" step of a LinkedIn outreach sequence for the campaign "${campaign.name}" at Twenty2 Collective, a Perth-based Agile and change consultancy.

Campaign goal: ${campaign.goal || 'not specified'}
Target ICP: ${campaign.targetSegmentSummary || 'not specified'}
Pitch angle: ${campaign.pitchAngle || 'not specified'}
Objection handling: ${campaign.objectionHandling || 'not specified'}
Strategy: ${campaign.strategyBrief || 'not specified'}
Touch type: ${currentType || 'not specified'}
Current draft: ${currentContent || '(none yet)'}

T2C's historical conversion data for this campaign, factor it in if relevant: ${historicalNote || 'no campaign insights run yet for this campaign'}.

Rewrite this message. UK English, no em dashes, peer to peer tone, one observation and one question, 3-4 sentences, signed off "Twenty2 Collective". Return only the message text, nothing else.`;

    const message = await callClaudeText(prompt, 300);
    res.json({ success: true, message });
  } catch (err) {
    console.error('Campaign redraft-stage error:', err.message);
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

  const campaignIdOrName = decodeURIComponent(req.params.id);

  try {
    const [contactRecords, touchPointRecords, conversions, campaigns, campaignRecord] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      fetchConversions(),
      fetchCampaigns(),
      resolveCampaignRecord(campaignIdOrName)
    ]);

    // Re-derive the canonical Name from the resolved record rather than
    // trusting campaignIdOrName - it may be a record id, and campaigns[]
    // (from fetchCampaigns) only matches on Name.
    const campaignName = campaignRecord ? (campaignRecord.fields['Name'] || '') : campaignIdOrName;
    const campaign = campaigns.find(c => c.name === campaignName);
    if (!campaignRecord || !campaign) return res.status(404).json({ error: 'Campaign not found in Airtable' });

    const contacts = contactRecords.map(r => ({ id: r.id, name: r.fields['Full Name'] || '' }));
    const touchPoints = touchPointRecords.map(r => ({
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

  const campaignIdOrName = decodeURIComponent(req.params.id);

  try {
    const [contactRecords, touchPointRecords, conversions, campaigns, learningData, campaignRecord] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      fetchConversions(),
      fetchCampaigns(),
      fetchLearningData(),
      resolveCampaignRecord(campaignIdOrName)
    ]);

    // Re-derive the canonical Name from the resolved record rather than
    // trusting campaignIdOrName - it may be a record id, and campaigns[]
    // (from fetchCampaigns) only matches on Name.
    const campaignName = campaignRecord ? (campaignRecord.fields['Name'] || '') : campaignIdOrName;
    const campaign = campaigns.find(c => c.name === campaignName);
    if (!campaignRecord || !campaign) return res.status(404).json({ error: 'Campaign not found in Airtable' });

    const contacts = contactRecords.map(r => ({
      id: r.id,
      name: r.fields['Full Name'] || '',
      role: r.fields['Job Title'] || '',
      company: r.fields['Company'] || '',
      journeyStage: r.fields['Journey Stage'] || ''
    }));
    const touchPoints = touchPointRecords.map(r => ({
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
      const [contactRecord, touchPointRecords] = await Promise.all([
        airtableGetRecord('Contacts', contactId),
        airtableFetchAllRecords('Touch Points')
      ]);
      if (contactRecord) {
        const f = contactRecord.fields || {};
        const touchPoints = touchPointRecords
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
  const campaignIdOrName = decodeURIComponent(req.params.id);
  try {
    const campaignRecord = await resolveCampaignRecord(campaignIdOrName);
    if (!campaignRecord) return res.status(404).json({ error: 'Campaign not found' });

    const [ccRows, dealRecords, tpRecords, contactRecords, companyRecords, repRecords] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords('Reps')
    ]);

    const contactsById = {}; contactRecords.forEach(r => { contactsById[r.id] = r; });
    const companiesById = {}; companyRecords.forEach(r => { companiesById[r.id] = r; });
    const repsById = {}; repRecords.forEach(r => { repsById[r.id] = r; });

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

    const deals = dealRecords
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

    const touchPoints = tpRecords
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

    const reps = repRecords.map(r => ({ id: r.id, name: r.fields['Name'] || '', email: r.fields['Email'] || '' }));
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
  const campaignIdOrName = decodeURIComponent(req.params.id);
  try {
    const campaignRecord = await resolveCampaignRecord(campaignIdOrName);
    if (!campaignRecord) return res.status(404).json({ error: 'Campaign not found' });

    const [ccRows, dealRecords, tpRecords, contactRecords] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Contacts')
    ]);

    const contactsById = {}; contactRecords.forEach(r => { contactsById[r.id] = r; });

    const myCcRows = ccRows.filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
    const myContactIds = new Set(myCcRows.map(r => (r.fields['Contact'] || [])[0]).filter(Boolean));
    const myDeals = dealRecords.filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id));
    const myTouchPoints = tpRecords.filter(r =>
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

// Top-level Sales page > Overview tab AI insights panel. Aggregates every
// Live/Past campaign's Campaign Contacts + Deals + Touch Points rows into a
// compact per-campaign summary (a lighter pass than the full stage-history
// funnel math sales-overview above feeds the per-campaign Sales tab - good
// enough for the model to reason over) and asks Claude for a handful of
// bullet takeaways across the whole pipeline.
// Same "reached Connected or later" stage list the per-campaign Sales
// tab's FUNNEL_STAGE_GROUPS['connected'] uses client-side - the early
// stages (Found, Connection Pending/Requested) don't count as connected.
// Shared by /api/sales/insights and the offer learning-loop metrics below.
const CONNECTED_OR_LATER_STAGES = ['Connected', 'Message 1 Sent', 'Pending Reply M1', 'Ready for Message 2', 'Message 2 Sent', 'Pending Reply M2', 'Ready for Message 3', 'Message 3 Sent', 'Pending Reply M3', 'Meeting Booked'];

app.get('/api/sales/insights', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const [campaignRecords, ccRows, dealRecords, tpRecords] = await Promise.all([
      airtableFetchAllRecords('Campaigns'),
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Touch Points')
    ]);

    const campaigns = campaignRecords
      .filter(r => (r.fields['Status'] || '') !== 'Draft')
      .map(r => ({ id: r.id, name: r.fields['Name'] || '', status: r.fields['Status'] || '' }));

    if (!campaigns.length) {
      return res.json({ insights: ['No live or past campaigns yet — insights will appear once a campaign goes live.'], generatedAt: new Date().toISOString() });
    }

    const summary = campaigns.map(c => {
      const myCc = ccRows.filter(r => (r.fields['Campaign'] || []).includes(c.id));
      const myDeals = dealRecords.filter(r => (r.fields['Campaign'] || []).includes(c.id));
      const myContactIds = new Set(myCc.map(r => (r.fields['Contact'] || [])[0]).filter(Boolean));
      const myTouchPoints = tpRecords.filter(r => (r.fields['Campaign'] || []).includes(c.id) || (r.fields['Contact'] || []).some(cid => myContactIds.has(cid)));

      const connections = myCc.filter(r => CONNECTED_OR_LATER_STAGES.includes(r.fields['Sequence Stage'] || '')).length;
      const messagesSent = myTouchPoints.filter(r => !touchPointIsReply(r.fields)).length;
      const meetingsBooked = myCc.filter(r => (r.fields['Sequence Stage'] || '') === 'Meeting Booked').length;
      const won = myDeals.filter(r => r.fields['Outcome'] === 'Won').length;
      const lost = myDeals.filter(r => r.fields['Outcome'] === 'Lost').length;

      return { name: c.name, status: c.status, contacts: myCc.length, connections, messagesSent, meetingsBooked, won, lost };
    });

    const prompt = `You are a sales analyst reviewing outreach campaign performance for a B2B agency. Here is a summary of every live or past campaign:

${summary.map(s => `- ${s.name} (${s.status}): ${s.contacts} contacts, ${s.connections} connections made, ${s.messagesSent} messages sent, ${s.meetingsBooked} meetings booked, ${s.won} won, ${s.lost} lost`).join('\n')}

Write 3-5 bullet point insights a sales lead would find useful - call out standout campaigns (best/worst), pipeline risks, and any patterns worth acting on. Each bullet must be one plain sentence with no markdown formatting, one per line, no numbering or leading dashes.`;

    const text = await callClaudeText(prompt, 700);
    const insights = text.split('\n')
      .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter(Boolean);

    res.json({ insights, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Sales insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== OFFERS (Hormozi Grand Slam Offer system) =====================
 * Airtable "Offers" table (linked 1:many from Campaigns, prefers one Active
 * offer per campaign at a time - older ones get retired, not deleted, so
 * they remain available as performance history for future /generate calls).
 * Field names used below match that table's existing schema exactly. */

const OFFERS_TABLE = 'Offers';

function offerFromRecord(r) {
  const f = r.fields || {};
  return {
    id: r.id,
    name: f['Offer Name'] || '',
    campaignId: (f['Campaign'] || [])[0] || null,
    icpType: f['ICP Type'] || '',
    goal: f['Goal'] || '',
    dreamOutcome: f['Dream Outcome'] || '',
    timeToValue: f['Time to Value'] || '',
    effortAndSacrifice: f['Effort and Sacrifice'] || '',
    guarantee: f['Guarantee'] || '',
    summary: f['Offer Summary'] || '',
    meetingsBooked: f['Meetings Booked'] || 0,
    replyRate: f['Reply Rate'] || 0,
    connectionRate: f['Connection Rate'] || 0,
    engagementScore: f['Engagement Score'] || 0,
    status: f['Status'] || '',
    notes: f['Notes'] || ''
  };
}

// The Sales tab's Offer section and outreach message generation (Today's
// Actions / Intelligence tab) both need "the current active offer for this
// campaign" - centralized here so both read the same definition of
// "active" (Status = Active, most recently created if more than one).
async function getActiveOfferForCampaign(campaignRecordId) {
  if (!campaignRecordId) return null;
  const allRecords = await airtableFetchAllRecords(OFFERS_TABLE);
  const records = allRecords
    .filter(r => (r.fields['Campaign'] || []).includes(campaignRecordId) && r.fields['Status'] === 'Active')
    .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  return records.length ? offerFromRecord(records[0]) : null;
}

// GET the active offer for a campaign - Sales tab's Offer section.
app.get('/api/campaign/:id/offer', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const campaignRecord = await resolveCampaignRecord(decodeURIComponent(req.params.id));
    if (!campaignRecord) return res.status(404).json({ error: 'Campaign not found in Airtable' });
    const offer = await getActiveOfferForCampaign(campaignRecord.id);
    res.json({ offer, campaignRecordId: campaignRecord.id });
  } catch (err) {
    console.error('Get campaign offer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generates a recommended offer from ICP/goal/product, informed by T2C's
// own best-performing past offers for a similar ICP. Used both by the
// campaign-creation "Generate offer for me" path (no campaignId yet - the
// campaign hasn't been saved to Airtable at that point in the chat flow)
// and the Sales tab's "Generate new offer" button (campaignId set, so its
// own current offer is excluded from the comparison pool).
app.post('/api/offers/generate', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { icp, goal, product, campaignId } = req.body;
  if (!icp) return res.status(400).json({ error: 'icp is required' });

  try {
    const [offerRecords, campaignRecords] = await Promise.all([
      airtableFetchAllRecords(OFFERS_TABLE),
      airtableFetchAllRecords('Campaigns')
    ]);
    const campaignById = {};
    campaignRecords.forEach(r => { campaignById[r.id] = r; });

    // "Similar ICP" = at least one significant (4+ letter) word shared with
    // the target ICP text - a lightweight filter, not a rigid taxonomy,
    // since ICP Type is free text.
    const icpWords = new Set((icp.toLowerCase().match(/[a-z]{4,}/g) || []));

    const pastOffers = offerRecords
      .filter(r => (r.fields['Campaign'] || [])[0] !== campaignId)
      .filter(r => r.fields['Dream Outcome'] || r.fields['Offer Summary'])
      .map(r => {
        const linkedCampaignId = (r.fields['Campaign'] || [])[0] || null;
        const campaign = linkedCampaignId ? campaignById[linkedCampaignId] : null;
        // Airtable "Contact Count" is a count rollup already on Campaigns -
        // goal completion rate is derived from it rather than stored, since
        // the Offers table has no dedicated field for it.
        const contactCount = campaign ? (campaign.fields['Contact Count'] || 0) : 0;
        const meetingsBooked = r.fields['Meetings Booked'] || 0;
        const goalCompletionRate = contactCount ? Math.round((meetingsBooked / contactCount) * 100) : 0;
        const icpType = r.fields['ICP Type'] || '';
        const similarIcp = icpType ? [...icpWords].some(w => icpType.toLowerCase().includes(w)) : false;
        return {
          campaignName: campaign ? (campaign.fields['Name'] || campaign.fields['Campaign Name'] || '') : '',
          icpType,
          goalCompletionRate,
          engagementScore: r.fields['Engagement Score'] || 0,
          dreamOutcome: r.fields['Dream Outcome'] || '',
          timeToValue: r.fields['Time to Value'] || '',
          effortAndSacrifice: r.fields['Effort and Sacrifice'] || '',
          guarantee: r.fields['Guarantee'] || '',
          similarIcp
        };
      });

    const similar = pastOffers.filter(o => o.similarIcp);
    const candidatePool = similar.length ? similar : pastOffers;
    const ranked = candidatePool
      .sort((a, b) => (b.engagementScore + b.goalCompletionRate) - (a.engagementScore + a.goalCompletionRate))
      .slice(0, 5);

    const prompt = `You are building a Hormozi-style Grand Slam Offer (Dream Outcome, Speed/Time to Value, Effort & Sacrifice, Guarantee) for a new outreach campaign at Twenty2 Collective (T2C), a Perth-based Agile and change consultancy.

New campaign:
- Target ICP: ${icp}
- Goal: ${goal || 'not recorded'}
- Product/service: ${product || 'not recorded'}

${ranked.length ? `Here are T2C's best-performing past offers for a similar ICP, ranked by engagement score and goal completion rate (use these to inform what has actually worked, not just theory):
${ranked.map(o => `- "${o.campaignName}" (ICP: ${o.icpType || 'not recorded'}, engagement score ${o.engagementScore}, goal completion ${o.goalCompletionRate}%): Dream outcome: ${o.dreamOutcome || 'n/a'}. Time to value: ${o.timeToValue || 'n/a'}. Effort: ${o.effortAndSacrifice || 'n/a'}. Guarantee: ${o.guarantee || 'n/a'}.`).join('\n')}` : `No past offers with a similar ICP exist yet - base this on T2C's general positioning as an Agile/change consultancy.`}

Generate a new Grand Slam Offer for this campaign. Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "dreamOutcome": string, "timeToValue": string, "effortAndSacrifice": string, "guarantee": string, "summary": string, "rationale": string }

"summary" is a single persuasive paragraph combining all four components, written so it can be dropped directly into a LinkedIn outreach message. "rationale" is one or two sentences naming which past campaign(s) informed this offer and why, or noting this is a first-of-its-kind offer if no past campaign applied.`;

    const parsed = await callClaudeJson(prompt, 1200);
    res.json({
      offer: {
        dreamOutcome: parsed.dreamOutcome || '',
        timeToValue: parsed.timeToValue || '',
        effortAndSacrifice: parsed.effortAndSacrifice || '',
        guarantee: parsed.guarantee || '',
        summary: parsed.summary || ''
      },
      rationale: parsed.rationale || '',
      informedBy: ranked.map(o => o.campaignName).filter(Boolean)
    });
  } catch (err) {
    console.error('Offer generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Build it together" path - turns the four raw sequential-question
// answers into one cohesive narrative paragraph, same shape as the
// "summary" field /api/offers/generate produces, so both paths feed the
// same downstream save/display code identically.
app.post('/api/offers/compose', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { dreamOutcome, timeToValue, effortAndSacrifice, guarantee } = req.body;
  if (!dreamOutcome || !timeToValue || !effortAndSacrifice || !guarantee) {
    return res.status(400).json({ error: 'dreamOutcome, timeToValue, effortAndSacrifice, and guarantee are all required' });
  }
  try {
    const prompt = `Turn these four raw answers into one persuasive paragraph combining them into a single Grand Slam Offer summary, written so it can be dropped directly into a LinkedIn outreach message. UK English, no em dashes, no markdown.

Dream outcome: ${dreamOutcome}
Speed / time to value: ${timeToValue}
Effort required from them: ${effortAndSacrifice}
Guarantee: ${guarantee}

Return only the paragraph, nothing else.`;
    const summary = await callClaudeText(prompt, 400);
    res.json({ summary });
  } catch (err) {
    console.error('Offer compose error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Writes a completed offer to Airtable, linked to the campaign, as the new
// Active offer - retiring (not deleting) whatever was Active before so it
// stays available as performance history. Used by both campaign-creation
// paths (once the campaign itself has been saved and has a real record
// id) and the Sales tab's "Generate new offer" flow once the generated
// recommendation has been reviewed/accepted.
app.post('/api/offers/save', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { campaignId, campaignName, icp, goal, dreamOutcome, timeToValue, effortAndSacrifice, guarantee, summary, rationale } = req.body;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  if (!dreamOutcome || !timeToValue || !effortAndSacrifice || !guarantee) {
    return res.status(400).json({ error: 'dreamOutcome, timeToValue, effortAndSacrifice, and guarantee are all required' });
  }

  try {
    const existing = await airtableFetchAllRecords(OFFERS_TABLE);
    const activeForCampaign = existing.filter(r => (r.fields['Campaign'] || []).includes(campaignId) && r.fields['Status'] === 'Active');
    if (activeForCampaign.length) {
      await airtableRequest('PATCH', OFFERS_TABLE, {
        records: activeForCampaign.map(r => ({ id: r.id, fields: { 'Status': 'Retired' } }))
      });
    }

    const fields = {
      'Offer Name': `${campaignName || 'Campaign'} — Offer`,
      'Campaign': [campaignId],
      'ICP Type': icp || '',
      'Goal': goal || '',
      'Dream Outcome': dreamOutcome,
      'Time to Value': timeToValue,
      'Effort and Sacrifice': effortAndSacrifice,
      'Guarantee': guarantee,
      'Offer Summary': summary || '',
      'Status': 'Active'
    };
    if (rationale) fields['Notes'] = rationale;

    const data = await airtableRequest('POST', OFFERS_TABLE, { records: [{ fields }] });
    res.json({ success: true, offerId: data.records[0].id });
  } catch (err) {
    console.error('Offer save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sales tab's Edit button - patches an existing offer's fields in place
// without touching Status or retiring anything.
app.patch('/api/offers/:id', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { dreamOutcome, timeToValue, effortAndSacrifice, guarantee, summary } = req.body;
  try {
    const fields = {};
    if (dreamOutcome !== undefined) fields['Dream Outcome'] = dreamOutcome;
    if (timeToValue !== undefined) fields['Time to Value'] = timeToValue;
    if (effortAndSacrifice !== undefined) fields['Effort and Sacrifice'] = effortAndSacrifice;
    if (guarantee !== undefined) fields['Guarantee'] = guarantee;
    if (summary !== undefined) fields['Offer Summary'] = summary;
    await airtableRequest('PATCH', OFFERS_TABLE, { records: [{ id: req.params.id, fields }] });
    res.json({ success: true });
  } catch (err) {
    console.error('Offer edit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Offer learning loop: reads this campaign's Campaign Contacts + Touch
// Points and writes Meetings Booked / Reply Rate / Connection Rate (plus a
// derived Engagement Score) onto its Active offer, so future
// /api/offers/generate calls can rank past offers by what actually
// performed. ccRows/tpRecords/offerRecords are optional pre-fetched
// tables, passed by updateAllOfferMetrics's cron sweep so it fetches each
// table once instead of once per campaign.
async function updateOfferMetricsForCampaign(campaignId, ccRows, tpRecords, offerRecords) {
  const rows = ccRows || await fetchCampaignContactsRows();
  const touchPoints = tpRecords || (await airtableFetchAllRecords('Touch Points'));
  const offers = offerRecords || (await airtableFetchAllRecords(OFFERS_TABLE));

  const myCc = rows.filter(r => (r.fields['Campaign'] || []).includes(campaignId));
  if (!myCc.length) return null;

  const myContactIds = new Set(myCc.map(r => (r.fields['Contact'] || [])[0]).filter(Boolean));
  const myTouchPoints = touchPoints.filter(r => (r.fields['Campaign'] || []).includes(campaignId) || (r.fields['Contact'] || []).some(cid => myContactIds.has(cid)));

  const totalContacts = myCc.length;
  const connected = myCc.filter(r => CONNECTED_OR_LATER_STAGES.includes(r.fields['Sequence Stage'] || '')).length;
  const meetingsBooked = myCc.filter(r => (r.fields['Sequence Stage'] || '') === 'Meeting Booked').length;
  const messagesSent = myTouchPoints.filter(r => !touchPointIsReply(r.fields));
  const repliesReceived = myTouchPoints.filter(r => touchPointIsReply(r.fields));

  const connectionRate = totalContacts ? Math.round((connected / totalContacts) * 100) : 0;
  const replyRate = messagesSent.length ? Math.round((repliesReceived.length / messagesSent.length) * 100) : 0;
  const engagementScore = Math.round((connectionRate + replyRate) / 2);

  const activeOffer = offers.find(r => (r.fields['Campaign'] || []).includes(campaignId) && r.fields['Status'] === 'Active');
  if (!activeOffer) return null;

  await airtableRequest('PATCH', OFFERS_TABLE, {
    records: [{
      id: activeOffer.id,
      fields: {
        'Meetings Booked': meetingsBooked,
        'Reply Rate': replyRate,
        'Connection Rate': connectionRate,
        'Engagement Score': engagementScore
      }
    }]
  });
  return { meetingsBooked, replyRate, connectionRate, engagementScore };
}

app.post('/api/offers/update-metrics', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { campaignId } = req.body;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
  try {
    const metrics = await updateOfferMetricsForCampaign(campaignId);
    if (!metrics) return res.json({ success: false, reason: 'No campaign contacts or no Active offer for this campaign' });
    res.json({ success: true, metrics });
  } catch (err) {
    console.error('Offer update-metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Daily sweep for the cron job below - fetches each shared table once,
// then updates every campaign's Active offer metrics from it.
async function updateAllOfferMetrics() {
  const [campaignRecords, ccRows, tpRecords, offerRecords] = await Promise.all([
    airtableFetchAllRecords('Campaigns'),
    fetchCampaignContactsRows(),
    airtableFetchAllRecords('Touch Points'),
    airtableFetchAllRecords(OFFERS_TABLE)
  ]);
  for (const campaign of campaignRecords) {
    try {
      await updateOfferMetricsForCampaign(campaign.id, ccRows, tpRecords, offerRecords);
    } catch (err) {
      console.warn(`Offer metrics update failed for campaign ${campaign.id} (non-fatal):`, err.message);
    }
  }
}

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

    if (outcome === 'Lost') {
      trigifyDeleteContactSearch(contactId)
        .catch(err => console.warn('Could not delete Trigify search for lost contact (non-fatal):', err.message));
    }

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
    const records = await airtableFetchAllRecords('Reps');
    res.json({ reps: records.map(r => ({ id: r.id, name: r.fields['Name'] || '', email: r.fields['Email'] || '' })) });
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
    const resp = await airtableFetchWithRetry(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
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
    const [dealRecords, reminderRecords, contactRecords, companyRecords, campaignRecords, repRecords] = await Promise.all([
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Reminders'),
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords('Campaigns'),
      airtableFetchAllRecords('Reps')
    ]);
    const contactsById = {}; contactRecords.forEach(r => { contactsById[r.id] = r; });
    const companiesById = {}; companyRecords.forEach(r => { companiesById[r.id] = r; });
    const campaignsById = {}; campaignRecords.forEach(r => { campaignsById[r.id] = r; });
    const repsById = {}; repRecords.forEach(r => { repsById[r.id] = r; });

    let events = dealRecords
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

    const reminderEvents = reminderRecords
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

    const [tpRecords, dealRecords, contactRecords, companyRecords, existingSignalRecords] = await Promise.all([
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords(CONTENT_SIGNALS_TABLE)
    ]);

    const contactsById = {};
    contactRecords.forEach(r => { contactsById[r.id] = r; });
    const companiesById = {};
    companyRecords.forEach(r => { companiesById[r.id] = r; });

    const recentTouchPoints = tpRecords
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
    dealRecords.forEach(r => {
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

    const recentSignalThemes = existingSignalRecords
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
    contactRecords.forEach(r => { if (r.fields['Full Name']) contactsByName[r.fields['Full Name']] = r; });
    const companiesByName = {};
    companyRecords.forEach(r => { if (r.fields['Company Name']) companiesByName[r.fields['Company Name']] = r; });

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
    const [signalRecords, contactRecords, companyRecords, campaignRecord] = await Promise.all([
      airtableFetchAllRecords(CONTENT_SIGNALS_TABLE),
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);
    const contactsById = {}; contactRecords.forEach(r => { contactsById[r.id] = r.fields['Full Name'] || ''; });
    const companiesById = {}; companyRecords.forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });

    let records = signalRecords.filter(r => (r.fields['Status'] || 'New') !== 'Dismissed');
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
    const [contentRecords, companyRecords, campaignRecords, campaignRecord] = await Promise.all([
      airtableFetchAllRecords(CONTENT_TABLE),
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords('Campaigns'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);
    const companiesById = {}; companyRecords.forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });
    const campaignsById = {}; campaignRecords.forEach(r => { campaignsById[r.id] = r.fields['Name'] || ''; });

    // Rows from the old, dead legacy content feature never have a Format
    // (they use the unrelated Content Type field instead) - filtering on
    // Format truthy is how this Draft Centre stays clear of them.
    let records = contentRecords.filter(r => r.fields['Format']);
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
    const [campaigns, contactRecords] = await Promise.all([fetchCampaigns(), airtableFetchAllRecords('Contacts')]);
    const activeCampaigns = campaigns.filter(c => c.status === 'Live');
    const prompt = `T2C Outreach has ${activeCampaigns.length} active (Live) campaign(s) out of ${campaigns.length} total, and ${contactRecords.length} contacts in the pipeline.

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

// ===================== APP CONFIG (shared Settings page state) =====================
// The Settings page's timeout/services/accounts/strategy/leadMagnets/
// products config used to live only in each browser's localStorage - see
// persistState/loadPersistedState in t2c-outreach-crm.html. Reuses the same
// Settings singleton row as the LinkedIn URL route above
// (getSettingsRecord/getOrCreateSettingsRecord). The nested array/object
// sub-settings (services/accounts/strategy/leadMagnets/products) are stored
// as JSON text fields rather than split into their own tables - this is
// ~13 small setters for a handful of internal users, not a case that needs
// a real relational schema per sub-setting.
app.get('/api/settings/app-config', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const record = await getSettingsRecord();
    res.json(record ? record.fields : {});
  } catch (err) {
    console.error('Get app-config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/app-config', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { timeoutDays, timeoutAction, services, accounts, strategy, leadMagnets, products, makeWebhookUrl, clayApiKey } = req.body;

  try {
    const settingsRecord = await getOrCreateSettingsRecord();
    const fields = {};
    if (typeof timeoutDays === 'number') fields['Timeout Days'] = timeoutDays;
    if (timeoutAction) fields['Timeout Action'] = timeoutAction;
    // Presence, not truthiness, for the JSON blobs below - an empty array
    // is a legitimate "user cleared this list" state, not "wasn't
    // supplied". Safe here because saveSettings() (the only caller) always
    // sends the complete settings object, never a partial one - unlike
    // every other endpoint in this file, an empty value here is real intent
    // to write, not evidence of an unhydrated/partial payload.
    if (services !== undefined) fields['Services JSON'] = JSON.stringify(services);
    if (accounts !== undefined) fields['Accounts JSON'] = JSON.stringify(accounts);
    if (strategy !== undefined) fields['Strategy JSON'] = JSON.stringify(strategy);
    if (leadMagnets !== undefined) fields['Lead Magnets JSON'] = JSON.stringify(leadMagnets);
    if (products !== undefined) fields['Products JSON'] = JSON.stringify(products);
    if (makeWebhookUrl !== undefined) fields['Make Webhook URL'] = makeWebhookUrl;
    if (clayApiKey !== undefined) fields['Clay API Key'] = clayApiKey;

    if (Object.keys(fields).length) {
      await airtableRequest('PATCH', SETTINGS_TABLE, { records: [{ id: settingsRecord.id, fields }] });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Save app-config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Separate from app-config above since it's written from a completely
// different place in the app (runAnalysis(), not saveSettings()) with
// different call frequency - bundling it in would mean every analysis run
// re-sends the whole settings object for no reason.
app.get('/api/settings/last-analysis', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const record = await getSettingsRecord();
    const raw = record && record.fields['Last Analysis JSON'];
    let analysis = null;
    if (raw) { try { analysis = JSON.parse(raw); } catch (e) { analysis = null; } }
    res.json({ analysis });
  } catch (err) {
    console.error('Get last-analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/last-analysis', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { analysis } = req.body;
  if (!analysis) return res.status(400).json({ error: 'analysis is required' });

  try {
    const settingsRecord = await getOrCreateSettingsRecord();
    await airtableRequest('PATCH', SETTINGS_TABLE, {
      records: [{ id: settingsRecord.id, fields: { 'Last Analysis JSON': JSON.stringify(analysis) } }]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Save last-analysis error:', err.message);
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
// monitor, called from PATCH /api/context/contact-fields once the contact
// actually reaches Sequence Stage "Connected" - not at contact creation, so
// a contact that's found but never connects never gets an unnecessary
// search opened for them. No-ops quietly if Trigify isn't configured - the
// caller must never fail because of this.
//
// Checks for an existing search on this profile URL first (via
// trigifyFindExistingSearch's GET /v1/searches lookup, the same one
// trigifyEnsureMarcusSearch/the Trigify backfill route already use
// reactively after a 409) instead of always attempting a create - a
// duplicate contact save, or a contact re-added after being removed and
// re-found, would otherwise either 409 (previously left silently
// unregistered, since the caller only logs-and-swallows this function's
// errors) or create a second search for the same profile.
async function trigifyCreateContactSearch(contactId, contactName, linkedinUrl) {
  if (!TRIGIFY_API_KEY || !AIRTABLE_API_KEY) return;
  const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
  const searchName = `T2C — ${contactName}`;
  const existingId = await trigifyFindExistingSearch(normalizedUrl, searchName);
  const searchId = existingId || await trigifyCreateProfileMonitor(searchName, normalizedUrl, { maxResults: 10, frequency: 'DAILY' });
  await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'Trigify Search ID': searchId } }] });
}

// Fire-and-forget teardown of a contact's Trigify profile monitor, called
// when a contact is marked Lost (POST /api/campaign/:id/deals with
// outcome "Lost") or Excluded (POST /api/campaign/:id/contacts/:contactId/
// exclude) - no point continuing to pay for/poll a monitor for someone
// no longer being pursued. No-ops quietly if Trigify isn't configured, the
// contact has no Trigify Search ID yet, or the contact record can't be
// found - same "never fail the caller over this" convention as the create
// side above.
//
// Always protects the primary account's own monitor: refuses to delete
// when the contact's LinkedIn URL matches Settings' "My LinkedIn URL", or
// when the search id matches Settings' "Trigify Marcus Search ID"
// (belt-and-suspenders - the URL check is the one actually asked for, the
// search-id check catches the same case even if the URL comparison ever
// drifted) - see trigifyEnsureMarcusSearch above for where that search
// comes from. Losing Marcus's own content-performance monitor would be a
// much worse outcome than leaving one contact's stale search running.
async function trigifyDeleteContactSearch(contactId) {
  if (!TRIGIFY_API_KEY || !AIRTABLE_API_KEY) return;
  const contactRecord = await airtableGetRecord('Contacts', contactId);
  if (!contactRecord) return;
  const searchId = contactRecord.fields['Trigify Search ID'];
  if (!searchId) return;

  const settingsRecord = await getSettingsRecord();
  const myLinkedInUrl = settingsRecord && settingsRecord.fields['My LinkedIn URL'];
  const myMarcusSearchId = settingsRecord && settingsRecord.fields['Trigify Marcus Search ID'];
  const contactLinkedInUrl = contactRecord.fields['LinkedIn URL'];
  const isPrimaryAccountUrl = !!(myLinkedInUrl && contactLinkedInUrl && normalizeLinkedInUrl(contactLinkedInUrl) === normalizeLinkedInUrl(myLinkedInUrl));
  const isPrimaryAccountSearchId = !!(myMarcusSearchId && searchId === myMarcusSearchId);
  if (isPrimaryAccountUrl || isPrimaryAccountSearchId) {
    console.warn(`Refusing to delete Trigify search ${searchId} for contact ${contactId} - it matches the protected primary account (Settings' "My LinkedIn URL").`);
    return;
  }

  // Trigify's documented API surface (see the TRIGIFY INTEGRATION comment
  // above) only lists POST .../linkedin/profile and GET .../{id}/results -
  // no delete endpoint is documented there. This follows the same REST
  // convention the rest of the API already uses; worth confirming against
  // Trigify's actual docs/support if this 404s in practice.
  await trigifyRequest('DELETE', `/v1/searches/${searchId}`);
  await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: { 'Trigify Search ID': '' } }] });
}

function normalizeTrigifyPost(p) {
  const reactions = p.reactions;
  const engagement = p.engagement;
  return {
    text: p.text || p.content || p.body || '',
    // Actual post-publish-date fields first; collected_at/collectedAt is
    // when Trigify's crawler picked the post up (i.e. sync time), not when
    // it was posted, so those stay as the last resort only.
    date: p.date_posted || p.datePosted || p.published_at || p.publishedAt || p.postedAt || p.date || p.createdAt || p.created_at || p.collected_at || p.collectedAt || '',
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

// Trigify's raw post fields can arrive nested (e.g. { text: { value: '...' } })
// rather than as plain strings/numbers - normalizeTrigifyPost's field-name
// fallback chain (p.text || p.content || p.body) picks the first truthy one
// but doesn't unwrap it further, so a nested object was landing in
// formatRecentPosts's output as the literal string "[object Object]" once
// written to the Recent Posts field. Unwraps one level of common nested
// shapes before stringifying.
function extractPostValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object') {
    const nested = value.text ?? value.value ?? value.content ?? value.body ?? value.plain ?? value.raw;
    return nested !== undefined ? extractPostValue(nested) : '';
  }
  return value;
}

// Same nested-value unwrap + parse used by formatRecentPosts, pulled out so
// the job-change signal writers below can stamp the real Trigify post date
// instead of defaulting to whenever the sync happened to run.
function normalizePostDate(value) {
  const raw = extractPostValue(value);
  const parsed = raw ? new Date(raw) : null;
  return parsed && !isNaN(parsed) ? parsed.toISOString().slice(0, 10) : '';
}

function formatRecentPosts(posts) {
  return posts.map(p => {
    const date = normalizePostDate(p.date);
    const text = String(extractPostValue(p.text)).replace(/\s+/g, ' ').trim();
    const likes = extractPostValue(p.likes);
    const comments = extractPostValue(p.comments);
    return `[${date}] ${text} | Likes: ${likes === '' ? 0 : likes} Comments: ${comments === '' ? 0 : comments}`;
  }).join('\n\n');
}

// Shared 7-day recency guard for job-change detection - both the
// per-profile Claude-based check and the keyword monitor below should only
// ever consider posts from the last week, so a job change flagged from a
// months-old post (Trigify's own frequency/time_frame settings don't
// guarantee freshness on every result) never gets written to Job Change
// Signal even if its text matches the language being looked for.
function isWithinLastDays(dateStr, days) {
  if (!dateStr) return false;
  const parsed = new Date(dateStr);
  if (isNaN(parsed)) return false;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return parsed.getTime() >= cutoffMs;
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

    // Recent Posts above still shows all 3 regardless of age - only what
    // feeds job-change detection is restricted to the last 7 days.
    const recentEnough = top3.filter(p => isWithinLastDays(p.date, 7));
    const jobChange = await detectJobChangeFromPosts(recentEnough);
    if (jobChange) {
      // Use the actual Trigify post date, not the time this sync ran.
      // detectJobChangeFromPosts doesn't say which of the (up to 3) posts
      // triggered the signal, so prefer whichever post's date matches what
      // Claude echoed back, falling back to the newest post (recentEnough
      // is newest-first) since every post here already passed the 7-day
      // isWithinLastDays filter and so has a real, parseable date.
      const matchedPost = recentEnough.find(p => normalizePostDate(p.date) === normalizePostDate(jobChange.date)) || recentEnough[0];
      const postDate = normalizePostDate(matchedPost.date);
      fields['Job Change Signal'] = `${jobChange.newCompanyOrRole || 'Possible job change'}${postDate ? ' — ' + postDate : ''}`;
      fields['Job Change Signal Date'] = postDate || new Date().toISOString().slice(0, 10);
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

// Removed: GET /api/trigify/backfill-contacts used to register every
// contact with a LinkedIn URL and no Trigify Search ID yet, regardless of
// Sequence Stage - that's no longer correct now that monitor creation only
// happens once a contact reaches "Connected" (see PATCH /api/context/
// contact-fields and trigifyCreateContactSearch's comment above), so
// leaving this callable risked accidentally opening monitors for
// found-but-never-connected contacts again.

app.get('/api/trigify/sync-contact-posts', async (req, res) => {
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

// Parses one contact's Recent Posts field (written by formatRecentPosts, see
// above - "[date] text | Likes: N Comments: N" blocks joined by blank
// lines) back into individual post objects for the Home page's Contact
// signals strip.
function parseRecentPosts(recentPostsText) {
  if (!recentPostsText) return [];
  return recentPostsText.split('\n\n').map(block => {
    const m = block.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*([\s\S]*?)\s*\|\s*Likes:\s*(-?\d+)\s*Comments:\s*(-?\d+)\s*$/);
    if (!m) return null;
    const [, date, text, likes, comments] = m;
    if (!text.trim()) return null;
    return { date, text: text.trim(), likes: parseInt(likes, 10) || 0, comments: parseInt(comments, 10) || 0 };
  }).filter(Boolean);
}

// Contact's Recent Posts, filtered to the last `days` and formatted for
// dropping straight into an outreach-message prompt - keeps Claude from
// referencing a post that's old enough to be a stale/odd callback.
function recentPostsPromptSnippet(recentPostsField, days) {
  const posts = parseRecentPosts(recentPostsField).filter(p => isWithinLastDays(p.date, days));
  if (!posts.length) return 'none recent';
  return posts.map(p => `[${p.date}] ${p.text}`).join('\n');
}

// Home page "Contact signals" strip - one card per post from contacts who
// are (a) in a Live campaign and (b) have a non-empty Recent Posts field
// (populated by GET /api/trigify/sync-contact-posts), newest post first.
app.get('/api/contacts/recent-posts-signals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  try {
    const [contactRecords, companyRecords] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies')
    ]);

    const companyNameById = {};
    companyRecords.forEach(c => { companyNameById[c.id] = c.fields['Company Name'] || ''; });

    // Every contact with a Trigify Search ID and post activity, not just
    // those in an active (Live) campaign - the previous Live-campaign
    // filter meant a job change or other signal on a contact between
    // campaigns (or not yet assigned to one) never surfaced here.
    const signals = [];
    contactRecords.forEach(r => {
      if (!r.fields['Trigify Search ID']) return;
      const posts = parseRecentPosts(r.fields['Recent Posts']);
      if (!posts.length) return;
      const contactName = r.fields['Full Name'] || 'Unknown';
      const company = (r.fields['Company'] || []).map(id => companyNameById[id]).filter(Boolean).join(', ');
      posts.forEach(p => signals.push({ contactId: r.id, contactName, company, ...p }));
    });

    signals.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ signals });
  } catch (err) {
    console.error('Contact signals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One contact's Recent Posts field, parsed - used by the "Recent posts"
// section of the contact enrichment profile panel, which needs raw
// Airtable data rather than anything from the AI enrichment call.
app.get('/api/contacts/:id/recent-posts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const contactRecord = await airtableGetRecord('Contacts', req.params.id);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });
    const posts = parseRecentPosts((contactRecord.fields || {})['Recent Posts']);
    res.json({ posts });
  } catch (err) {
    console.error('Contact recent posts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Home page "Contact signals" strip - every contact with a populated Job
// Change Signal field (written by syncTrigifyContactPosts's per-profile
// Claude detection, syncJobChangeMonitorSignals's keyword search match, or
// checkContactJobChanges's weekly Serper check) whose Job Change Signal Date
// falls within the last 14 days - Job Change Signal itself is never cleared
// automatically, so without this a months-old signal would keep showing
// here forever.
app.get('/api/contacts/job-change-signals', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const [contactRecords, companyRecords] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Companies')
    ]);

    const companyNameById = {};
    companyRecords.forEach(c => { companyNameById[c.id] = c.fields['Company Name'] || ''; });

    const signals = contactRecords
      .filter(r => r.fields['Job Change Signal'] && isWithinLastDays(r.fields['Job Change Signal Date'], 14))
      .map(r => ({
        contactId: r.id,
        contactName: r.fields['Full Name'] || 'Unknown',
        company: (r.fields['Company'] || []).map(id => companyNameById[id]).filter(Boolean).join(', '),
        linkedinUrl: r.fields['LinkedIn URL'] || '',
        jobChangeSignal: r.fields['Job Change Signal']
      }));

    res.json({ signals });
  } catch (err) {
    console.error('Job change signals error:', err.message);
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
  const [contacts, companyRecords] = await Promise.all([
    airtableFetchAllRecords('Contacts'),
    airtableFetchAllRecords('Companies')
  ]);
  const companiesById = {};
  companyRecords.forEach(r => { companiesById[r.id] = r.fields['Company Name'] || ''; });

  const targets = contacts.filter(c => c.fields['LinkedIn URL'] && c.fields['Job Title']);
  const updates = [];

  for (const contact of targets) {
    const name = contact.fields['Full Name'];
    const companyId = (contact.fields['Company'] || [])[0];
    const companyName = companyId ? companiesById[companyId] : '';
    if (!companyName) continue;

    try {
      // Same AU bias (gl:'au' + location:'Australia') as
      // searchContactViaSerper/researchContactEnrichment above - the
      // exact-quoted name+company already narrows this a lot, but a common
      // name at a company with offices outside Australia can still surface
      // the wrong person's profile.
      const serperRes = await fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: `"${name}" "${companyName}" site:linkedin.com Australia`, gl: 'au', location: 'Australia' })
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

      updates.push({ id: contact.id, fields: {
        'Job Change Signal': `Signal detected possible title change: ${headline} — verify manually`,
        'Job Change Signal Date': new Date().toISOString().slice(0, 10)
      } });
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

const TRIGIFY_JOB_CHANGE_MONITOR_NAME = 'T2C Job Change Monitor';
const TRIGIFY_JOB_CHANGE_KEYWORDS = ['excited to join', 'new role', 'starting as', 'thrilled to announce', 'joining as'];
const TRIGIFY_JOB_CHANGE_KEYWORDS_NOT = ['hiring'];

// One-time setup for a Trigify LinkedIn posts keyword search watching for
// job-change language across LinkedIn generally, not scoped to any one
// contact's own profile (unlike trigifyCreateProfileMonitor). Its results
// are matched against Contacts by author name/LinkedIn URL in the daily
// sync cron (syncJobChangeMonitorSignals, below), contributing to Job
// Change Signal alongside the existing per-profile Claude-based detection.
// Idempotent like trigifyEnsureMarcusSearch - returns the existing search
// id from Settings if setup has already run.
async function trigifyCreateJobChangeMonitor() {
  const settingsRecord = await getOrCreateSettingsRecord();
  let searchId = settingsRecord.fields['Job Change Monitor ID'] || null;
  if (searchId) return searchId;

  try {
    const result = await trigifyRequest('POST', '/v1/searches/linkedin/posts', {
      name: TRIGIFY_JOB_CHANGE_MONITOR_NAME,
      keywords: TRIGIFY_JOB_CHANGE_KEYWORDS,
      keywords_not: TRIGIFY_JOB_CHANGE_KEYWORDS_NOT,
      frequency: 'DAILY',
      max_results: 100
    });
    console.log('Trigify create-job-change-monitor raw response:', JSON.stringify(result));
    searchId = (result.data && result.data.id) || result.id || (result.search && result.search.id);
    if (!searchId) throw new Error('Trigify did not return a search id');
  } catch (err) {
    if (err.status === 409 && /already/i.test(err.body || '')) {
      searchId = await trigifyFindExistingSearch(null, TRIGIFY_JOB_CHANGE_MONITOR_NAME);
      if (!searchId) throw new Error('Trigify reported this search already exists, but no matching search was found in GET /v1/searches');
    } else {
      throw err;
    }
  }

  await airtableRequest('PATCH', SETTINGS_TABLE, {
    records: [{ id: settingsRecord.id, fields: { 'Job Change Monitor ID': searchId } }]
  });
  return searchId;
}

app.get('/api/trigify/setup-job-change-monitor', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!TRIGIFY_API_KEY) return res.status(500).json({ error: 'TRIGIFY_API_KEY not configured' });
  try {
    const searchId = await trigifyCreateJobChangeMonitor();
    res.json({ success: true, searchId });
  } catch (err) {
    console.error('Trigify setup-job-change-monitor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetches the Job Change Monitor's latest keyword-search results and
// matches each post's author against Contacts by (normalised) LinkedIn URL
// first, falling back to an exact case-insensitive Full Name match. Skips
// a contact that already has a Job Change Signal - this runs alongside
// syncTrigifyContactPosts's per-profile Claude detection and
// checkContactJobChanges's weekly Serper check, so all three contribute to
// the same field without clobbering each other's find.
async function syncJobChangeMonitorSignals() {
  const settingsRecord = await getSettingsRecord();
  const searchId = settingsRecord && settingsRecord.fields['Job Change Monitor ID'];
  if (!searchId) return { matched: 0, message: 'Job Change Monitor not set up yet - run /api/trigify/setup-job-change-monitor first' };

  const rawResults = await trigifyGetSearchResults(searchId);
  const results = (rawResults || []).map(r => {
    const author = r.author || {};
    return {
      authorName: author.name || r.author_name || '',
      authorProfileUrl: author.profile_url || r.author_profile_url || '',
      text: String(extractPostValue((r.content && r.content.text) || r.text || '')).trim(),
      date: r.date_posted || r.datePosted || r.published_at || r.date || ''
    };
  }).filter(r => r.text && isWithinLastDays(r.date, 7));

  const contacts = await airtableFetchAllRecords('Contacts');
  const contactByUrl = {};
  const contactByName = {};
  contacts.forEach(c => {
    const url = normalizeLinkedInUrl(c.fields['LinkedIn URL'] || '');
    if (url) contactByUrl[url] = c;
    const name = (c.fields['Full Name'] || '').trim().toLowerCase();
    if (name) contactByName[name] = c;
  });

  const updates = [];
  results.forEach(r => {
    const url = r.authorProfileUrl ? normalizeLinkedInUrl(r.authorProfileUrl) : '';
    const match = (url && contactByUrl[url]) || (r.authorName && contactByName[r.authorName.trim().toLowerCase()]);
    if (!match || match.fields['Job Change Signal']) return;
    // Same fix as syncTrigifyContactPosts: stamp the post's own date, not
    // whenever this sync happened to run.
    const postDate = normalizePostDate(r.date);
    updates.push({
      id: match.id,
      fields: {
        'Job Change Signal': `${r.text.slice(0, 300)}${postDate ? ' — ' + postDate : ''}`,
        'Job Change Signal Date': postDate || new Date().toISOString().slice(0, 10)
      }
    });
  });

  for (let i = 0; i < updates.length; i += 10) {
    await airtableRequest('PATCH', 'Contacts', { records: updates.slice(i, i + 10), typecast: true });
  }
  return { checked: results.length, matched: updates.length };
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

    const [companyRecords, campaignRecords, ccRows, tpRecords, dealRecords, campaignRecord] = await Promise.all([
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords('Campaigns'),
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Deals'),
      campaignName ? findCampaignRecordByName(campaignName) : Promise.resolve(null)
    ]);

    const companiesById = {}; companyRecords.forEach(r => { companiesById[r.id] = r; });
    const campaignsById = {}; campaignRecords.forEach(r => { campaignsById[r.id] = r; });

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

    let touchPoints = tpRecords
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

    const deals = dealRecords
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
    const enrichment = parseContactEnrichment(cf['AI Summary']);

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
        jobChangeSignal: cf['Job Change Signal'] || '',
        enrichment,
        lastEnrichedDate: enrichment ? enrichment.date : null
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

    const profile = await researchContactEnrichment(name, company, contactRecord.fields['LinkedIn URL'] || '');
    try {
      await persistContactEnrichment(contactRecord, profile);
    } catch (airtableErr) {
      console.warn('Could not store enrichment profile to Airtable:', airtableErr.message);
    }

    res.json({ success: true, profile, enrichedDate: profile.date });
  } catch (err) {
    console.error('Contact enrich error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Today's Actions "Generate brief" (generateContactBrief in
// t2c-outreach-crm.html) - either a ready-to-send message or a short prep
// brief depending on the recommended communication method, built from the
// contact's local touch point history the client already assembled.
app.post('/api/contacts/generate-brief', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { contact, action, method, touchHistory, voice } = req.body || {};
  if (!contact || !contact.name) return res.status(400).json({ error: 'contact.name is required' });
  if (!action || !action.type || !method) return res.status(400).json({ error: 'action.type and method are required' });

  try {
    const isMessage = method === 'LinkedIn message' || method === 'Email';
    const prompt = `Contact: ${contact.name}, ${contact.role || ''} at ${contact.company || ''}.
Journey stage: ${contact.journeyStage || 'unknown'}.
Pain points on file: ${(contact.painPoints && contact.painPoints.length) ? contact.painPoints.join(', ') : 'none logged'}.
Today's recommended action: ${action.type}.
Recommended communication method: ${method}.

Full touch point history:
${touchHistory || 'No touch points logged yet.'}

${isMessage
  ? `Write a ready-to-send ${method === 'LinkedIn message' ? 'LinkedIn message' : 'email'} for this contact given the above. ${voiceRulesPromptText(voice)} Return only the message text.`
  : `Write a short prep brief for a ${method.toLowerCase()} with this contact. Return 3-4 bullet points covering what to cover, what to reference from the history above, and what to avoid. Return only the bullet points, one per line, each starting with "- ".`}`;

    const message = await callClaudeText(prompt, 400);
    res.json({ success: true, message, isMessage });
  } catch (err) {
    console.error('Generate brief error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Roadmap "Read connections screenshot" (readConnectionsScreenshot in
// t2c-outreach-crm.html) and the Logger's "Log Connections" mode
// (runLoggerConnectionsMatch) - cross-references names visible in one or
// more LinkedIn "My Network" screenshots, or pasted text copied from that
// same page, against the given list of contacts still awaiting connection
// acceptance, returning which of them appear to have accepted.
app.post('/api/contacts/match-connections-screenshot', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { candidates, images, text } = req.body || {};
  // candidates can legitimately be empty - the Logger's Log Connections
  // mode still wants "extracted" below (every person mentioned, so it can
  // offer importing anyone new) even when nobody is currently awaiting
  // connection acceptance to cross-reference against.
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const hasImages = Array.isArray(images) && images.length;
  if (!hasImages && !text) return res.status(400).json({ error: 'images or text is required' });

  try {
    const list = candidateList.length
      ? candidateList.map(c => `${c.id}: ${c.name} (${c.company})`).join('\n')
      : '(none currently awaiting connection acceptance)';
    const source = hasImages ? 'the attached screenshot(s) of a LinkedIn connections list' : 'this text pasted from a LinkedIn connections list';
    // Selecting text straight off LinkedIn's "My Network" page and pasting
    // it carries over page furniture Claude would otherwise have to guess
    // the shape of - spelling it out here (rather than leaving it to infer
    // from schema alone) is what actually makes the noisy paste reliable,
    // the same reasoning as the worked examples on the Logger's other
    // Claude-parsing endpoints (see LOGGER_PARSE_CONVERSATION_SYSTEM above).
    const textFormatNote = hasImages ? '' : `A raw paste from that page repeats this block per connection - match only on the name, and ignore "'s profile picture" and the "Message" button line, they're page furniture, not part of anyone's name or title:
<Name>'s profile picture
<Name>

<job title / headline, sometimes several lines>

Connected on <Month Day, Year>

Message

`;
    // "extracted" covers EVERY person visible/mentioned, matched or not -
    // the Logger's Log Connections mode (unlike the Roadmap caller, which
    // only ever reads matchedIds) uses this to offer importing anyone who
    // isn't already a contact anywhere in the CRM, not just anyone missing
    // from the (deliberately narrow) candidates list above.
    const promptText = `Cross-reference the names visible in ${source} against this list of contacts awaiting connection acceptance:\n${list}\n\n${textFormatNote}${hasImages ? '' : `Pasted text:\n${text}\n\n`}Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{ "matchedIds": ["c4","c9"], "extracted": [ { "name": "Jane Doe", "company": "Acme", "role": "Product Owner" } ] }

matchedIds: contact ids from the list above whose names appear as accepted connections. Empty array if none.
extracted: every person visible/mentioned, one entry each, regardless of whether they matched. Infer company and role from their headline where possible (e.g. "Product Owner @ Aurecon" -> company "Aurecon", role "Product Owner"); if no company is evident, use an empty string for company but still give a short best-guess role from the headline.`;

    const content = hasImages
      ? [...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })), { type: 'text', text: promptText }]
      : promptText;

    // 200 tokens was enough for the original screenshot use case (a photo
    // only ever shows a handful of connections at once), but a large real
    // candidate pool matched against a full text paste of someone's network
    // can genuinely need to return dozens of Airtable record ids plus the
    // full extracted list below - each id is ~18 characters, quoted and
    // comma-separated - which was silently truncating mid-array into
    // invalid JSON and surfacing as a generic "could not read that" error
    // instead of the real matches.
    const rawText = await callClaudeText(content, 3000);
    let parsed;
    try {
      const cleaned = stripCodeFences(rawText);
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch (parseErr) {
      console.error('Match connections screenshot: malformed JSON from Claude:', rawText);
      throw new Error('Could not parse Claude response as JSON');
    }

    const matchedIds = Array.isArray(parsed.matchedIds) ? parsed.matchedIds : [];
    const extracted = (Array.isArray(parsed.extracted) ? parsed.extracted : [])
      .filter(p => p && p.name)
      .map(p => ({ name: String(p.name).trim(), company: p.company ? String(p.company).trim() : '', role: p.role ? String(p.role).trim() : '' }));

    res.json({ success: true, matchedIds, extracted });
  } catch (err) {
    console.error('Match connections screenshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-time backfill for contacts synced before Contacts had its own Grid
// Name field (see createOrUpdateAirtableContact) - those inherited their
// grid tag implicitly from their company, which is exactly the crossover
// mechanism the field was added to avoid. The client already has each
// contact's correctly-resolved gridId in state (accounting for shared
// companies, blank companies, etc. - see hydrateContactsFromAirtable), so
// it sends {id, gridName} pairs straight from that rather than this route
// trying to re-derive grid membership from scratch server-side. Same
// append-not-overwrite convention as the per-contact write in
// createOrUpdateAirtableContact, so a contact that's already picked up a
// tag since that shipped isn't clobbered, just topped up - and a single
// fetch-all + batched patch here instead of one sync call per contact.
app.post('/api/contacts/backfill-grid-tags', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { tags } = req.body || {};
  if (!Array.isArray(tags) || !tags.length) return res.status(400).json({ error: 'tags is required' });

  try {
    const records = await airtableFetchAllRecords('Contacts');
    const byId = {};
    records.forEach(r => { byId[r.id] = r; });

    const patches = [];
    tags.forEach(({ id, gridName }) => {
      if (!id || !gridName) return;
      const record = byId[id];
      if (!record) return;
      const gridNames = parseGridNameList(record.fields['Grid Name']);
      if (!gridNames.includes(gridName)) {
        gridNames.push(gridName);
        patches.push({ id, fields: { 'Grid Name': gridNames.join(', ') } });
      }
    });

    if (patches.length) await airtableBatchPatch('Contacts', patches);
    res.json({ success: true, tagged: patches.length, skipped: tags.length - patches.length });
  } catch (err) {
    console.error('Backfill grid tags error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Same purpose as the Contacts version above, for Companies - matched by
// name rather than record id, since state.grids[].companies is just a list
// of company name strings on the client (no Airtable record id tracked for
// them). A company can need more than one grid name appended (it's
// deliberately allowed to sit on several grids - see
// findOrCreateCompanyRecord), so tags for the same company are grouped
// before writing, and each record gets exactly one PATCH covering every
// grid it needs rather than one per (company, grid) pair.
app.post('/api/companies/backfill-grid-tags', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { tags } = req.body || {};
  if (!Array.isArray(tags) || !tags.length) return res.status(400).json({ error: 'tags is required' });

  try {
    const records = await airtableFetchAllRecords('Companies');
    const byName = {};
    records.forEach(r => { byName[(r.fields['Company Name'] || '').toLowerCase()] = r; });

    const gridNamesByRecordId = {};
    let skipped = 0;
    tags.forEach(({ name, gridName }) => {
      if (!name || !gridName) { skipped++; return; }
      const record = byName[name.toLowerCase()];
      if (!record) { skipped++; return; }
      if (!gridNamesByRecordId[record.id]) gridNamesByRecordId[record.id] = parseGridNameList(record.fields['Grid Name']);
      const list = gridNamesByRecordId[record.id];
      if (!list.includes(gridName)) list.push(gridName);
      else skipped++;
    });

    const patches = Object.entries(gridNamesByRecordId).map(([id, gridNames]) => ({ id, fields: { 'Grid Name': gridNames.join(', ') } }));
    if (patches.length) await airtableBatchPatch('Companies', patches);
    res.json({ success: true, tagged: patches.length, skipped });
  } catch (err) {
    console.error('Backfill company grid tags error:', err.message);
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
    const resp = await airtableFetchWithRetry(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
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

    const [contactRecords, tpRecords, dealRecords, signalRecords] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Deals'),
      airtableFetchAllRecords('Content Signals')
    ]);

    const myContactIds = new Set(cf['Contacts'] || []);
    const contactsById = {}; contactRecords.forEach(r => { contactsById[r.id] = r; });

    const keyContacts = contactRecords
      .filter(r => myContactIds.has(r.id))
      .map(r => ({ id: r.id, name: r.fields['Full Name'] || '', journeyStage: r.fields['Journey Stage'] || '' }));

    const touchPoints = tpRecords
      .filter(r => (r.fields['Contact'] || []).some(cid => myContactIds.has(cid)))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        const contact = contactId ? contactsById[contactId] : null;
        return { date: r.fields['Date'] || '', type: r.fields['Type'] || '', notes: r.fields['Summary'] || '', contactName: contact ? (contact.fields['Full Name'] || '') : '' };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const deals = dealRecords
      .filter(r => (r.fields['Company'] || []).includes(companyRecord.id))
      .map(r => ({ id: r.id, outcome: r.fields['Outcome'] || '', dealValue: r.fields['Deal Value'] || 0, date: r.fields['Date'] || '', notes: r.fields['Notes'] || '' }));

    const contentSignals = signalRecords
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
//
// airtableFetchAllRecords, not airtableRequest - that only returns the
// first page (100 records). This function's own comment already promised
// "the whole table", but a campaign with more than 100 Campaign Contacts
// rows was silently only getting the first page everywhere this is called
// (20+ call sites - Roadmap, Today's Actions, Sales/Analytics, connection
// timeouts, the daily grid search's campaign-linking step, etc.), which is
// also why a grid search on a large, established campaign looked like it
// was only processing/linking the first 100 despite the cell list itself
// (already fixed to paginate) being complete.
async function fetchCampaignContactsRows() {
  try {
    const records = await airtableFetchAllRecords(CAMPAIGN_CONTACTS_TABLE);
    return records || [];
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
// ("Found") if none exists yet. `extraFields` merges additional fields onto
// the created row only (e.g. Connection Sent Date from the grid-search
// linker below) - never touches an existing row, same as the rest of this
// function's create-only-if-missing behaviour.
async function getOrCreateCampaignContactRow(contactId, contactName, campaignRecordId, campaignName, rows, extraFields) {
  const existing = findCampaignContactRow(rows, contactId, campaignRecordId);
  if (existing) return existing;
  const addedDate = new Date().toISOString().slice(0, 10);
  const data = await airtableRequest('POST', CAMPAIGN_CONTACTS_TABLE, {
    records: [{
      fields: Object.assign({
        'Name': `${contactName} — ${campaignName}`,
        'Contact': [contactId],
        'Campaign': [campaignRecordId],
        'Sequence Stage': 'Found',
        'Stage History': appendStageHistory('', 'Found', addedDate),
        'Added Date': addedDate
      }, extraFields || {})
    }]
  });
  return data.records[0];
}

// Today's Actions fast-action cards read this normalised Sequence Stage
// vocabulary: Found (not yet connected) -> Connection Pending (request
// sent, not yet accepted - a genuine waiting state, distinct from
// Connected) -> Connected (accepted - the "Connections Made" funnel stage
// client-side, CONNECTED_OR_LATER_STAGES below) -> Message 1 Sent ->
// Message 2 Sent -> Message 3 Sent, with reply-gating on messages handled
// by the DM-screenshot flow's richer vocabulary (SEQUENCE_STAGE_ADVANCE
// below: "Pending Reply MN" while waiting, "Ready for Message N+1" once a
// reply's been detected) passing through unchanged. Only "Connection
// Requested" (the old label for "Found") gets normalised - Connected must
// stay distinct from Connection Pending, or the fast-action card has no
// way to tell "just sent" from "accepted" and either shows "Generate
// message 1" before the connection is accepted or never shows it at all.
function normalizeSequenceStage(stage) {
  if (stage === 'Connection Requested') return 'Found';
  return stage || 'Found';
}

// Straight-line advance for the Today's Actions "Copy & mark sent" flow -
// no reply-gating between messages (no "Pending Reply"/"Ready for Message
// N" in between), unlike the DM-screenshot flow's SEQUENCE_STAGE_ADVANCE.
// Message 3 Sent is terminal: no further fast-action card shows for that
// contact. Found and Connection Pending aren't here - their next stage
// isn't reached by "mark sent" (Found has no message to send yet;
// Connection Pending advances to Connected via the "Connected" branch of
// PATCH /api/context/contact-fields once accepted, not by sending anything).
const SEQUENCE_STAGE_NEXT = {
  'Connected': 'Message 1 Sent',
  'Message 1 Sent': 'Message 2 Sent',
  'Message 2 Sent': 'Message 3 Sent'
};

// Which message number a "Generate message" click should draft, given the
// contact's current (normalised) Sequence Stage.
const MESSAGE_NUMBER_FOR_STAGE = {
  'Connected': 1,
  'Message 1 Sent': 2,
  'Message 2 Sent': 3
};

// Airtable caps batch writes at 10 records per request. typecast:true so a
// Sequence Stage value from the app's simplified vocabulary (e.g.
// "Connection Pending", "Timed Out") that isn't yet a configured choice on
// the single select gets added automatically instead of 422ing - without
// this, PATCH /api/context/contact-fields writing "Connection Pending" was
// failing on every "Send connection" click since that string was never a
// real choice on Campaign Contacts.Sequence Stage.
async function airtableBatchPatch(table, records) {
  for (let i = 0; i < records.length; i += 10) {
    await airtableRequest('PATCH', table, { records: records.slice(i, i + 10), typecast: true });
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

    const [rows, contactRecords] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Contacts')
    ]);
    const nameById = {};
    contactRecords.forEach(r => { nameById[r.id] = r.fields['Full Name'] || ''; });

    const result = rows
      .filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id))
      .map(r => {
        const contactId = (r.fields['Contact'] || [])[0] || null;
        return {
          campaignContactId: r.id,
          contactId,
          contactName: contactId ? (nameById[contactId] || '') : '',
          sequenceStage: normalizeSequenceStage(r.fields['Sequence Stage']),
          nextMessageDraft: r.fields['Next Message Draft'] || '',
          connectionSentDate: r.fields['Connection Sent Date'] || null
        };
      })
      .filter(r => r.contactName);

    res.json({ rows: result });
  } catch (err) {
    console.error('Campaign contacts fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Strategy tab "Check for timeouts" - flags any Campaign Contact still
// sitting at "Connection Pending" (connection sent, no reply/progress
// since) whose Connection Sent Date is older than timeoutDays. "No reply"
// here means the row hasn't advanced past Connection Pending at all - this
// fast-action flow has no separate "accepted" signal, so staying on
// Connection Pending past the window is the only available proxy. Writes
// 'Timed Out' as the new Sequence Stage (typecast in airtableBatchPatch
// adds it as a real choice the first time) and increments Campaigns.Timed
// Out by the number newly flagged.
app.post('/api/campaign/:id/check-timeouts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const timeoutDays = parseInt(req.body && req.body.timeoutDays, 10) || 10;

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const [rows, contactRecords] = await Promise.all([
      fetchCampaignContactsRows(),
      airtableFetchAllRecords('Contacts')
    ]);
    const nameById = {};
    contactRecords.forEach(r => { nameById[r.id] = r.fields['Full Name'] || ''; });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - timeoutDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const toFlag = rows.filter(r => {
      if (!(r.fields['Campaign'] || []).includes(campaignRecord.id)) return false;
      const stage = normalizeSequenceStage(r.fields['Sequence Stage']);
      const sentDate = r.fields['Connection Sent Date'];
      return stage === 'Connection Pending' && sentDate && sentDate < cutoffStr;
    });

    let totalTimedOut = campaignRecord.fields['Timed Out'] || 0;
    if (toFlag.length) {
      const today = new Date().toISOString().slice(0, 10);
      await airtableBatchPatch(CAMPAIGN_CONTACTS_TABLE, toFlag.map(r => ({
        id: r.id,
        fields: { 'Sequence Stage': 'Timed Out', 'Stage History': appendStageHistory(r.fields['Stage History'], 'Timed Out', today) }
      })));

      totalTimedOut += toFlag.length;
      await airtableRequest('PATCH', 'Campaigns', {
        records: [{ id: campaignRecord.id, fields: { 'Timed Out': totalTimedOut } }]
      });
    }

    const flaggedNames = toFlag
      .map(r => { const contactId = (r.fields['Contact'] || [])[0]; return contactId ? (nameById[contactId] || '') : ''; })
      .filter(Boolean);

    res.json({ success: true, flaggedCount: toFlag.length, flaggedNames, totalTimedOut });
  } catch (err) {
    console.error('Check timeouts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Same "message ${n} in this contact's sequence" CTA-timing logic as the
// client's ctaStrategyNote() (t2c-outreach-crm.html) - ported here so
// POST /api/messages/generate can build the identical prompt server-side.
function ctaStrategyNoteText(stageKey, messageNumber, messagesBeforeCta) {
  const n = parseInt(messagesBeforeCta, 10) || 2;
  const num = messageNumber || 0;
  if (stageKey === 'cta') {
    return `Strategy: this is the CTA ask (message ${num} in the sequence). Per the outreach strategy the CTA should land by message ${n}, so make the ask directly here${num > n ? ", it's already overdue so don't hold back" : ''}.`;
  }
  if (!num) return '';
  if (num >= n) {
    return `Strategy: the outreach strategy says the CTA should be introduced by message ${n}. This is message ${num}, so it's fine to start gently pointing toward the CTA if the moment fits, without being pushy about it.`;
  }
  return `Strategy: the outreach strategy says the CTA shouldn't appear until message ${n}. This is message ${num}, so keep this purely relationship-building, no CTA mention yet.`;
}

// Mirrors the client's voiceRulesText() - ported here for the same reason.
function voiceRulesPromptText(voice) {
  const v = voice || {};
  return `Voice rules: UK English, no em dashes, ${(v.tone || 'peer to peer').toLowerCase()} tone, one observation and one question per message, 3 to 4 sentences, signed off "Twenty2 Collective", conditional CTA framing (never pushy). Connection requests should be ${(v.connLength || 'short').toLowerCase()}. Follow-up cadence is ${(v.cadence || 'steady').toLowerCase()}. ${v.voiceInstructions || ''}`;
}

// Generates a message for the "Write & copy message" modal (openGenerateModal
// in t2c-outreach-crm.html) - previously done client-side by calling
// api.anthropic.com directly from the browser with no API key, which always
// failed silently to a local template fallback. Moved server-side so the
// generation actually runs, using the same ANTHROPIC_API_KEY every other
// Claude-calling route here uses. Distinct from
// POST /api/campaign/:id/contacts/:contactId/generate-message below, which
// drafts for a specific campaign's Sequence Stage rather than the
// account-level template/voice-profile flow this modal is used from.
app.post('/api/messages/generate', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { contact, enrichment, campaign, stage, voice, images } = req.body || {};
  if (!contact || !contact.name) return res.status(400).json({ error: 'contact.name is required' });
  if (!stage || !stage.key) return res.status(400).json({ error: 'stage.key is required' });

  try {
    const imgs = Array.isArray(images) ? images : [];
    const profileImages = imgs.filter(i => i.kind === 'profile');
    const convoImages = imgs.filter(i => i.kind === 'convo');
    let imageNote = '';
    if (profileImages.length) imageNote += ` You've been given ${profileImages.length} screenshot(s) of the contact's LinkedIn profile — read their bio, posts and work history and weave in anything relevant.`;
    if (convoImages.length) imageNote += ` You've also been given ${convoImages.length} screenshot(s) of the conversation so far — read what they actually said and write a reply that responds to it naturally, rather than restating the template.`;

    const campaignNote = campaign ? `\n\nThis contact is part of the active campaign "${campaign.name}" (goal: ${campaign.goal || 'not recorded'}). Campaign strategy: ${campaign.strategyBrief || 'none recorded'}. Write in line with this strategy.` : '';

    const enrichmentNote = enrichment ? `\n\nEnrichment data from research on this contact (weave in naturally, don't just list it back): current title ${enrichment.currentTitle || 'unknown'}; company ${enrichment.company || 'unknown'}; work history ${enrichment.workHistory || 'unknown'}; education ${enrichment.education || 'unknown'}; location ${enrichment.location || 'unknown'}.` : '';

    // This modal has no built-in memory of what's already been said - unlike
    // POST /api/campaign/:id/contacts/:contactId/generate-message below,
    // which is scoped to one campaign and always reads Conversation Context
    // fresh from Airtable, this route is only ever handed whatever the
    // client passes in. Without this lookup, a message 2+ draft here had no
    // way to know a reply had already come in, and read like a first touch
    // every time - regardless of how many messages had actually gone back
    // and forth. contact.id is the Airtable Contacts record id (state.contacts
    // items are hydrated with id: r.id) - resolve it the same way the fast
    // action's generate-message does, falling back to a name lookup so an
    // older client that hasn't sent an id yet still gets best-effort context.
    let conversationNote = '';
    try {
      const contactRecord = contact.id
        ? await airtableGetRecord('Contacts', contact.id)
        : await findRecordByFieldName('Contacts', 'Full Name', contact.name);
      if (contactRecord) {
        const cf = contactRecord.fields || {};
        conversationNote = `\n\nAI summary of this contact so far: ${cf['AI Summary'] || 'none yet'}. Conversation so far: ${cf['Conversation Context'] || 'none yet - this is the first message'}.`;
      }
    } catch (lookupErr) {
      console.warn('Could not load contact conversation history for message generation (non-fatal):', lookupErr.message);
    }

    const promptText = `Template for this stage:\n${stage.template || ''}\n\nContact: ${contact.name}, ${contact.role || ''} at ${contact.company || ''}. Sequence stage: ${stage.label || stage.key} (message ${stage.messageNumber || 'n/a'} in the sequence). Profile notes: ${contact.notes || 'none'}.${conversationNote}\n\n${ctaStrategyNoteText(stage.key, stage.messageNumber, voice && voice.messagesBeforeCta)}\n\n${voiceRulesPromptText(voice)}${imageNote}${campaignNote}${enrichmentNote}\n\nWrite the actual message for this specific contact, replacing placeholders naturally - if the conversation so far shows they've already replied, respond to what they actually said rather than reintroducing yourself. Return only the message text.`;

    const content = imgs.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } }));
    content.push({ type: 'text', text: promptText });

    const message = await callClaudeText(content, 400);
    res.json({ success: true, message });
  } catch (err) {
    console.error('Message generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generates a fresh account-level sequence-stage template (Settings > flow
// editor "Generate" button) - reuses the same ctaStrategyNoteText/
// voiceRulesPromptText helpers as POST /api/messages/generate above.
app.post('/api/messages/generate-template', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { stageLabel, roles, stageKey, messageNumber, voice } = req.body || {};
  if (!stageLabel || !stageKey) return res.status(400).json({ error: 'stageLabel and stageKey are required' });

  try {
    const roleList = (Array.isArray(roles) ? roles : []).join(', ') || 'senior leaders';
    const promptText = `Write a LinkedIn outreach template for the "${stageLabel}" stage of a sequence targeting ${roleList} at WA companies.\n\n${ctaStrategyNoteText(stageKey, messageNumber, voice && voice.messagesBeforeCta)}\n\n${voiceRulesPromptText(voice)}\n\nUse {{first}}, {{company}}, {{role}} as placeholders. Return only the message text.`;

    const message = await callClaudeText(promptText, 300);
    res.json({ success: true, message });
  } catch (err) {
    console.error('Generate template error:', err.message);
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
    const recentPosts = recentPostsPromptSnippet(cf['Recent Posts'], 30);
    // Only weave the offer in once the contact is past the first connection
    // message (messageNumber 1) - pitching the offer on first touch reads
    // as a cold sales blast rather than a peer-to-peer opener.
    const offer = messageNumber >= 2 ? await getActiveOfferForCampaign(campaignRecord.id) : null;

    // Marcus's own edits are the best signal for what "good" looks like for
    // *this* campaign - pull his 5 most recently sent messages in this same
    // campaign that he rewrote before sending (Draft Outcome "Sent edited"),
    // most recent row first, and show the original AI draft next to what he
    // actually sent so Claude can learn the direction of the edit, not just
    // the end result.
    const recentEditedExamples = rows
      .filter(r => (r.fields['Campaign'] || []).includes(campaignRecord.id) && r.fields['Draft Outcome'] === 'Sent edited' && r.fields['Final Message Sent'] && r.fields['Original Message Draft'])
      .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime))
      .slice(0, 5)
      .map(r => ({ original: r.fields['Original Message Draft'], edited: r.fields['Final Message Sent'] }));
    const examplesNote = recentEditedExamples.length
      ? `\n\nHere are up to 5 examples of messages Marcus personally edited before sending in this campaign (most recent first) - each pairs the AI draft with what he actually sent, so you can learn the tone and style he prefers for this campaign:\n${recentEditedExamples.map((ex, i) => `${i + 1}. AI draft: ${ex.original}\n   Marcus sent: ${ex.edited}`).join('\n\n')}`
      : '';

    const prompt = `You are drafting LinkedIn outreach message ${messageNumber} of 3 for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM.

Campaign: "${campaignName}". Goal: ${camp['Goal'] || 'not recorded'}. Product: ${camp['Product'] || 'not recorded'}. Target ICP: ${camp['Target ICP'] || 'not recorded'}. Strategy notes: ${camp['Strategy Notes'] || 'none recorded'}.

Contact: ${cf['Full Name'] || 'Unknown'}, ${cf['Job Title'] || ''}. AI summary: ${cf['AI Summary'] || 'none yet'}. Conversation so far: ${cf['Conversation Context'] || 'none yet - this is the first message'}.
Recent posts (last 30 days only): ${recentPosts}
${offer && offer.summary ? `\nThis campaign's offer: ${offer.summary}\nWeave the offer above into this message naturally, in your own words - do not paste it verbatim.` : ''}

Write only message ${messageNumber} in this contact's sequence for this specific campaign, following on naturally from the conversation so far (if any). UK English, no em dashes, peer to peer tone, 3-4 sentences, signed off "Twenty2 Collective". Return only the message text, no preamble.${examplesNote}`;

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
  const { message, draftOutcome } = req.body;
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

    // The pre-edit AI draft this row held before this send - captured now
    // because it's about to be cleared below. Kept alongside Final Message
    // Sent so generate-message can show Claude the original-vs-edited pair,
    // not just the end result.
    const originalDraft = row.fields['Next Message Draft'] || '';

    const today = new Date().toISOString().slice(0, 10);
    const stageFields = {
      'Sequence Stage': nextStage,
      'Stage History': appendStageHistory(row.fields['Stage History'], nextStage, today),
      'Next Message Draft': ''
    };
    // draftOutcome ('Sent verbatim'/'Sent edited') tells us whether Marcus sent
    // the AI draft as-is or rewrote it - feedback signal for how good the
    // draft actually was, diffed client-side against the draft this row held
    // before this send. Final Message Sent records what actually went out;
    // Original Message Draft preserves the pre-edit AI draft it's paired
    // with (as opposed to Next Message Draft, which gets cleared above) -
    // generate-message reads recent "Sent edited" rows back out of both
    // fields as style examples.
    stageFields['Final Message Sent'] = message;
    stageFields['Original Message Draft'] = originalDraft;
    if (draftOutcome) stageFields['Draft Outcome'] = draftOutcome;
    await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, {
      records: [{
        id: row.id,
        fields: stageFields
      }],
      typecast: true
    });

    // 'Name' isn't auto-generated by Airtable on this table (it's a plain
    // text primary field) - this write skipped it entirely, which is why
    // these rows were showing up as "Unnamed record" in the Airtable UI.
    // "[Campaign]_Message [N]" so it's immediately clear which campaign and
    // which message in the sequence this was, at a glance in the Airtable
    // grid - messageNumber here is the one just sent (MESSAGE_NUMBER_FOR_STAGE
    // keyed off `stage`, the row's stage *before* the advance above).
    const messageNumber = MESSAGE_NUMBER_FOR_STAGE[stage];
    await airtableRequest('POST', 'Touch Points', {
      records: [{
        fields: {
          'Name': `${campaignName}_Message ${messageNumber}`,
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

// "Reply?" Yes/No toggle on a Roadmap card's message step
// (t2c-outreach-crm.html, setReply) - this used to be local-only (just
// flipped c.thread[key].replied in memory, never synced), so it was lost on
// every reload and Airtable's Sequence Stage never left "Message N Sent"
// no matter what was clicked here. Reuses SEQUENCE_STAGE_ADVANCE - the same
// table the DM-screenshot flow (POST /api/context/parse-screenshot above)
// advances from - keyed off the row's actual current Sequence Stage rather
// than whatever stage the client's local state believes it's in, so this
// self-corrects even if that row had drifted out of sync.
app.post('/api/campaign/:id/contacts/:contactId/reply', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;
  const { replied } = req.body || {};
  if (typeof replied !== 'boolean') return res.status(400).json({ error: 'replied (boolean) is required' });

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });

    const rows = await fetchCampaignContactsRows();
    const row = await getOrCreateCampaignContactRow(contactId, (contactRecord.fields || {})['Full Name'] || contactId, campaignRecord.id, campaignName, rows);
    const currentStage = normalizeSequenceStage(row.fields['Sequence Stage']);
    const advance = SEQUENCE_STAGE_ADVANCE[currentStage];
    if (!advance) {
      return res.status(400).json({ error: `Contact is at Sequence Stage "${currentStage}" - not a stage a reply can advance from.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const newStage = replied ? advance.replied : advance.noReply;
    const stageFields = { 'Sequence Stage': newStage };
    if (newStage !== currentStage) {
      stageFields['Stage History'] = appendStageHistory(row.fields['Stage History'], newStage, today);
    }
    await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, { records: [{ id: row.id, fields: stageFields }], typecast: true });

    // Only log a Touch Point on an actual "yes" - toggling "no reply yet"
    // is a state check, not an event worth a row in the history.
    if (replied) {
      // currentStage here is always "Message N Sent" or "Pending Reply MN"
      // (the only keys SEQUENCE_STAGE_ADVANCE has), so it always has a
      // digit to pull the message number from for the Name below.
      const messageNumberMatch = currentStage.match(/(\d)/);
      const messageLabel = messageNumberMatch ? `Message ${messageNumberMatch[1]}` : currentStage;
      await airtableRequest('POST', 'Touch Points', {
        records: [{
          fields: {
            'Name': `${campaignName}_Reply to ${messageLabel}`,
            'Date': today,
            'Type': 'Inbound Reply',
            'Direction': 'Inbound',
            'Summary': 'Marked as replied from the Roadmap card - no message content captured here (log it via Conversation History or a DM screenshot for the actual text).',
            'Contact': [contactId],
            'Campaign': [campaignRecord.id]
          }
        }],
        typecast: true
      });
    }

    res.json({ success: true, previousStage: currentStage, newStage });
  } catch (err) {
    console.error('Reply toggle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Skip" on a Grid/Roadmap contact card (t2c-outreach-crm.html,
// handleSkipContact) - sets this contact's Campaign Contacts row for the
// given campaign to Sequence Stage "Excluded", the same value
// linkGridContactToCampaign checks for and refuses to overwrite, so a
// later day's grid search re-finding this person won't silently re-include
// them. Patches the row if one already exists (any prior stage), or
// creates it outright at "Excluded" if this contact was never linked to
// the campaign in the first place - either way there's a row recording
// the exclusion afterward.
app.post('/api/campaign/:id/contacts/:contactId/exclude', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;
  const { reason, note } = req.body || {};

  try {
    const campaignRecord = await findCampaignRecordByName(campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });

    const rows = await fetchCampaignContactsRows();
    const existing = findCampaignContactRow(rows, contactId, campaignRecord.id);
    const today = new Date().toISOString().slice(0, 10);

    const excludeFields = {
      'Sequence Stage': 'Excluded',
      'Stage History': appendStageHistory(existing ? existing.fields['Stage History'] : '', 'Excluded', today)
    };
    if (reason) excludeFields['Skip Reason'] = reason;
    if (note) excludeFields['Skip Note'] = note;

    if (existing) {
      await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, {
        records: [{ id: existing.id, fields: excludeFields }],
        typecast: true
      });
    } else {
      await getOrCreateCampaignContactRow(contactId, (contactRecord.fields || {})['Full Name'] || contactId, campaignRecord.id, campaignName, rows, excludeFields);
    }

    trigifyDeleteContactSearch(contactId)
      .catch(err => console.warn('Could not delete Trigify search for excluded contact (non-fatal):', err.message));

    res.json({ success: true });
  } catch (err) {
    console.error('Exclude contact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Contact profile drawer's stage dropdown (t2c-outreach-crm.html,
// updateContactDrawerStage) - patches this contact's Campaign Contacts row
// for the given campaign to the chosen stage, same existing-row-or-create
// pattern as the exclude route above. "Connection Made" maps to the
// Sequence Stage vocabulary's "Connected" for the same reason
// LOGGER_JOURNEY_STAGE_TO_SEQUENCE_STAGE does, above - so a stage set from
// here still reads correctly to every other Sequence-Stage-aware feature.
// "Lost" isn't otherwise part of that vocabulary (Deals has its own separate
// Outcome field for that) - typecast:true lets it through as a new select
// option rather than failing the write, same as the exclude route's own
// typecast:true PATCH just above.
const DRAWER_STAGE_TO_SEQUENCE_STAGE = {
  'Found': 'Found',
  'Connection Pending': 'Connection Pending',
  'Connection Made': 'Connected',
  'Meeting Booked': 'Meeting Booked',
  'Lost': 'Lost',
  'Excluded': 'Excluded'
};

app.patch('/api/campaign/:id/contacts/:contactId/stage', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;
  const { stage } = req.body || {};
  const sequenceStage = DRAWER_STAGE_TO_SEQUENCE_STAGE[stage];
  if (!sequenceStage) return res.status(400).json({ error: 'stage must be one of ' + Object.keys(DRAWER_STAGE_TO_SEQUENCE_STAGE).join(', ') });

  try {
    const campaignRecord = await findCampaignRecordByName(campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });

    const rows = await fetchCampaignContactsRows();
    const existing = findCampaignContactRow(rows, contactId, campaignRecord.id);
    const today = new Date().toISOString().slice(0, 10);

    const stageFields = {
      'Sequence Stage': sequenceStage,
      'Stage History': appendStageHistory(existing ? existing.fields['Stage History'] : '', sequenceStage, today)
    };

    if (existing) {
      await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, {
        records: [{ id: existing.id, fields: stageFields }],
        typecast: true
      });
    } else {
      await getOrCreateCampaignContactRow(contactId, (contactRecord.fields || {})['Full Name'] || contactId, campaignRecord.id, campaignName, rows, stageFields);
    }

    res.json({ success: true, sequenceStage });
  } catch (err) {
    console.error('Update contact stage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Necessary supporting infrastructure, not itself one of the requested
// changes: the only existing way to write Next Message Draft onto a
// Campaign Contacts row was buried inside the server-side generate-message
// endpoint. saveGeneratedMessage's drafts come from the client-side callAI()
// flow instead, so it needs its own write path here. Also doubles as the
// "Discarded" case for Draft Outcome - when a fast-action draft is cleared
// rather than sent, there's no message to log as a Touch Point and no stage
// to advance, just this one field to record on the row.
app.patch('/api/campaign/:id/contacts/:contactId/draft', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const campaignName = decodeURIComponent(req.params.id);
  const contactId = req.params.contactId;
  const { message, draftOutcome } = req.body;
  if (message === undefined && !draftOutcome) {
    return res.status(400).json({ error: 'message or draftOutcome is required' });
  }

  try {
    const campaignRecord = await findRecordByFieldName('Campaigns', 'Name', campaignName);
    if (!campaignRecord) return res.status(404).json({ error: `Campaign "${campaignName}" not found` });

    const contactRecord = await airtableGetRecord('Contacts', contactId);
    if (!contactRecord) return res.status(404).json({ error: 'Contact not found' });

    const rows = await fetchCampaignContactsRows();
    const row = await getOrCreateCampaignContactRow(contactId, (contactRecord.fields || {})['Full Name'] || contactId, campaignRecord.id, campaignName, rows);

    const fields = {};
    if (message !== undefined) fields['Next Message Draft'] = message;
    if (draftOutcome) fields['Draft Outcome'] = draftOutcome;

    await airtableRequest('PATCH', CAMPAIGN_CONTACTS_TABLE, { records: [{ id: row.id, fields }], typecast: true });

    res.json({ success: true });
  } catch (err) {
    console.error('Campaign contact draft update error:', err.message);
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
    const [companyRecords, contactRecords, touchPointRecords, campaignContactRows, campaignRecord] = await Promise.all([
      airtableFetchAllRecords('Companies'),
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      fetchCampaignContactsRows(),
      campaignName ? findRecordByFieldName('Campaigns', 'Name', campaignName) : Promise.resolve(null)
    ]);

    const companies = companyRecords
      .map(r => ({ id: r.id, name: r.fields['Company Name'] || '' }))
      .filter(c => c.name);

    const touchPointsByContact = {};
    touchPointRecords.forEach(r => {
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

    const contacts = contactRecords
      .map(r => {
        const companyIds = r.fields['Company'] || [];
        const recentTouchPoints = (touchPointsByContact[r.id] || [])
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 3);

        const myCampaignRows = campaignRowsByContact[r.id] || [];
        // Eligible for the CSV upload to advance to "Connected" if any
        // campaign row is still short of it: not yet requested at all
        // ("Connection Requested"/"Found") or requested but not yet
        // accepted ("Connection Pending" - see PATCH /api/context/contact-fields).
        const hasPendingConnection = myCampaignRows.some(cr => ['Connection Requested', 'Found', 'Connection Pending'].includes(cr.fields['Sequence Stage'] || ''));
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
// Two sequenceStage values this route handles, both syncing every one of
// this contact's Campaign Contacts rows rather than just the active
// campaign's, since sending/accepting a LinkedIn connection request is true
// account-wide, not per campaign:
// - 'Connection Pending': fired by the Today's Actions "Send connection"
//   click (sequenceStage) and by dragging a Roadmap card into the Connection
//   Pending column (journeyStage only, via syncJourneyStageForColumn) -
//   either one advances rows still at Found/"Connection Requested" forward
//   and stamps Connection Sent Date for the Roadmap day-counter and
//   Strategy tab timeout check.
// - 'Connected': fired by the LinkedIn Connections CSV upload card once it
//   matches a contact - advances rows still at "Connection Pending" (sent,
//   not yet accepted) forward to "Connected" (accepted). Must stay a
//   distinct Sequence Stage from Connection Pending, or Today's Actions
//   (getFastActionForCampaignContact, t2c-outreach-crm.html) can't tell
//   "just sent" from "accepted" and either shows "Generate message 1"
//   before the connection is accepted or never shows it at all.
// Rows already further along in a given campaign are left alone either way.
app.patch('/api/context/contact-fields', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactId, journeyStage, sequenceStage, jobTitle } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  if (!journeyStage && !jobTitle && !['Connection Pending', 'Connected'].includes(sequenceStage)) {
    return res.status(400).json({ error: 'journeyStage or jobTitle is required, or sequenceStage must be "Connection Pending" or "Connected"' });
  }

  try {
    if (journeyStage || jobTitle) {
      const contactFields = {};
      if (journeyStage) contactFields['Journey Stage'] = journeyStage;
      if (jobTitle) contactFields['Job Title'] = jobTitle;
      await airtableRequest('PATCH', 'Contacts', { records: [{ id: contactId, fields: contactFields }], typecast: true });
    }

    let campaignContactRowsSynced = 0;
    if (sequenceStage === 'Connection Pending' || journeyStage === 'Connection Pending') {
      const rows = await fetchCampaignContactsRows();
      const pendingRows = rows.filter(r => (r.fields['Contact'] || []).includes(contactId) && ['Connection Requested', 'Found'].includes(r.fields['Sequence Stage'] || ''));
      if (pendingRows.length) {
        const today = new Date().toISOString().slice(0, 10);
        await airtableBatchPatch(CAMPAIGN_CONTACTS_TABLE, pendingRows.map(r => ({
          id: r.id,
          fields: {
            'Sequence Stage': 'Connection Pending',
            'Stage History': appendStageHistory(r.fields['Stage History'], 'Connection Pending', today),
            'Connection Sent Date': today
          }
        })));
        campaignContactRowsSynced = pendingRows.length;
      }
    } else if (sequenceStage === 'Connected') {
      const rows = await fetchCampaignContactsRows();
      const acceptedRows = rows.filter(r => (r.fields['Contact'] || []).includes(contactId) && (r.fields['Sequence Stage'] || '') === 'Connection Pending');
      if (acceptedRows.length) {
        const today = new Date().toISOString().slice(0, 10);
        await airtableBatchPatch(CAMPAIGN_CONTACTS_TABLE, acceptedRows.map(r => ({
          id: r.id,
          fields: { 'Sequence Stage': 'Connected', 'Stage History': appendStageHistory(r.fields['Stage History'], 'Connected', today) }
        })));
        campaignContactRowsSynced = acceptedRows.length;

        // Trigify monitor creation moved here from contact creation - only
        // open a search once this contact actually reaches "Connected" (the
        // "Connections Made" funnel stage, see the comment above this
        // route), not for every found-but-never-connected contact.
        // Fire-and-forget, same as the old call site: must never fail this
        // request over a Trigify hiccup.
        const contactRecord = await airtableGetRecord('Contacts', contactId);
        const linkedinUrl = contactRecord && contactRecord.fields['LinkedIn URL'];
        if (contactRecord && linkedinUrl) {
          trigifyCreateContactSearch(contactId, contactRecord.fields['Full Name'] || contactId, linkedinUrl)
            .catch(err => console.warn('Could not create Trigify search on connect (non-fatal):', err.message));
        }
      }
    }

    res.json({ success: true, campaignContactRowsSynced });
  } catch (err) {
    console.error('Context contact-fields update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Mark as done" on a Today's Actions card (t2c-outreach-crm.html,
// handleMarkActionDone/handleMarkAllActionsDone) - a blunt "I've dealt with
// this, dismiss it" signal. Unlike PATCH /api/context/contact-fields above,
// it never touches Sequence Stage or Journey Stage (the card might be any
// action type - Draft message, Follow up, Reply back, not just a
// connection request), it just stamps Connection Sent Date=today on every
// Campaign Contacts row for this contact, same account-wide convention
// (sending/accepting a connection, or here, working an action, isn't
// scoped to one campaign) the 'Connection Pending' branch above uses for
// the same field.
app.post('/api/context/contact-mark-done', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactId } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  try {
    const rows = await fetchCampaignContactsRows();
    const matchingRows = rows.filter(r => (r.fields['Contact'] || []).includes(contactId));
    if (matchingRows.length) {
      const today = new Date().toISOString().slice(0, 10);
      await airtableBatchPatch(CAMPAIGN_CONTACTS_TABLE, matchingRows.map(r => ({
        id: r.id,
        fields: { 'Connection Sent Date': today }
      })));
    }
    res.json({ success: true, campaignContactRowsSynced: matchingRows.length });
  } catch (err) {
    console.error('Contact mark-done error:', err.message);
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

    const touchPointRecords = await airtableFetchAllRecords('Touch Points');
    const recentTouchPoints = touchPointRecords
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
    const [contactRecords, touchPointRecords, campaignRecord] = await Promise.all([
      airtableFetchAllRecords('Contacts'),
      airtableFetchAllRecords('Touch Points'),
      campaignName ? findRecordByFieldName('Campaigns', 'Name', campaignName) : Promise.resolve(null)
    ]);
    const contactsById = {};
    contactRecords.forEach(r => { contactsById[r.id] = r; });
    // Sequence Stage is per-campaign now (Campaign Contacts), so it's only
    // fetched and included in the prompt when this update was triggered
    // from a specific campaign's Intelligence tab.
    const campaignContactRows = campaignRecord ? await fetchCampaignContactsRows() : [];

    const updatedContacts = [];
    for (const contactId of (contactIds || [])) {
      const record = contactsById[contactId];
      if (!record) continue;
      const f = record.fields || {};
      const touchPoints = touchPointRecords
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
        const companyContactIds = contactRecords
          .filter(r => (r.fields['Company'] || []).includes(companyId))
          .map(r => r.id);
        const companyTouchPoints = touchPointRecords
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
          const recentPosts = recentPostsPromptSnippet(f['Recent Posts'], 30);
          // A "Ready for Message N" stage is always message 2+ (message 1
          // is sent straight through Today's Actions, never reply-gated),
          // so the offer is always in scope here once the campaign has one.
          const offer = await getActiveOfferForCampaign(campaignRecord.id);
          const draftPrompt = `You are drafting the next LinkedIn message for T2C Outreach, Twenty2 Collective's LinkedIn outreach CRM. This is for the "${campaignName}" campaign.

Contact: ${contactName}, ${f['Job Title'] || ''}.
AI Summary: ${f['AI Summary'] || 'none yet'}
Recent posts (last 30 days only): ${recentPosts}
${offer && offer.summary ? `This campaign's offer: ${offer.summary}\nWeave the offer above into this message naturally, in your own words - do not paste it verbatim.\n` : ''}Conversation so far: ${newContext}

Write the next message in the conversation, following on naturally from what they just said. UK English, no em dashes, peer to peer tone, 3-4 sentences, one observation and one question, signed off "Twenty2 Collective". Return only the message text.`;
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
      const tpType = parsed.replied ? 'Inbound Reply' : 'LinkedIn Message';
      // "[Campaign]_Message [N]" when this screenshot was parsed inside a
      // campaign (currentStage is always "Message N Sent"/"Pending Reply MN"
      // in that case, same digit-extraction as the reply-toggle endpoint
      // above) - same convention as mark-sent's Touch Points, so campaign-
      // scoped history reads consistently everywhere. Falls back to the
      // generic "[Type] - [Contact Name] - [Date]" label used elsewhere in
      // the app for an untagged screenshot (parsed outside any campaign, so
      // there's no Sequence Stage/message number to name it after).
      const messageNumberMatch = currentStage.match(/(\d)/);
      const nameLabel = (campaignName && messageNumberMatch)
        ? `${campaignName}_Message ${messageNumberMatch[1]}`
        : `${tpType} - ${contactName} - ${dateLabel}`;
      const tpFields = {
        'Name': nameLabel,
        'Date': dateLabel,
        'Type': tpType,
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
// generates during outreach. Bookings/Dead Contacts/Activity joined this
// list once they moved from per-browser localStorage to shared Airtable
// tables - the Danger Zone button already promised to clear them, and
// leaving them out here would mean it silently stopped doing that. Grids,
// Sequences and Settings stay excluded on purpose, same bucket as
// Campaigns/Reps/Content Settings/Content below - configuration the user
// set up, not data a reset should also destroy.
const WIPE_DATA_TABLES = ['Contacts', 'Companies', 'Touch Points', CAMPAIGN_CONTACTS_TABLE, 'Deals', CONTENT_SIGNALS_TABLE, 'Learning Data', 'Bookings', 'Dead Contacts', 'Activity'];

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
    const res = await airtableFetchWithRetry(`${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs.toString()}`, {
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
    const res = await airtableFetchWithRetry(`${AIRTABLE_URL}/${encodeURIComponent(table)}?${qs}`, {
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
//
// Requires an exact confirmation phrase in the body, not just a bare POST -
// this route is irreversible and, unlike every other write route in this
// file, isn't scoped to one record. The Settings > Danger zone UI is the
// only caller that knows the phrase; anything else hitting this route with
// no body (a scanner, a stray retry, a CSRF'd request) gets rejected before
// it touches Airtable.
const WIPE_DATA_CONFIRM_PHRASE = 'WIPE ALL DATA';
app.post('/api/wipe-data', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if ((req.body || {}).confirm !== WIPE_DATA_CONFIRM_PHRASE) {
    return res.status(400).json({ error: 'Missing or incorrect confirmation phrase' });
  }

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

// Strips gridName out of a Company's (possibly multi-grid) "Grid Name" list
// without touching the record otherwise - for a company kept alive by
// another still-existing grid, hard-deleting isn't right, but leaving the
// deleted grid's name sitting in that list isn't either: the next
// hydrateCompaniesFromAirtable load would hand it to resolveGridIdByName,
// which - finding no local grid by that name any more - silently recreates
// the "deleted" grid from scratch and repopulates it with every company
// still carrying the stale tag. Only records that actually have the tag get
// patched.
async function untagCompaniesFromGrid(gridName, companyNames) {
  if (!gridName || !Array.isArray(companyNames) || !companyNames.length) return;
  const records = (await Promise.all(
    companyNames.map(name => findRecordByFieldName('Companies', 'Company Name', name))
  )).filter(Boolean);

  const patches = records
    .map(r => ({ id: r.id, gridNames: parseGridNameList(r.fields['Grid Name']) }))
    .filter(r => r.gridNames.some(g => g.toLowerCase() === gridName.toLowerCase()))
    .map(r => ({ id: r.id, fields: { 'Grid Name': r.gridNames.filter(g => g.toLowerCase() !== gridName.toLowerCase()).join(', ') } }));

  if (patches.length) await airtableBatchPatch('Companies', patches);
}

// ===================== DELETE GRID (Home page) =====================
// Grids only exist client-side (see the "gridName"/"Grid Name" notes above),
// so the client tells us which Contact/Company names belonged to the grid
// being deleted - each name is looked up in Airtable and, if found, its
// record is removed. Companies shared with another grid are the client's
// responsibility to exclude from companyNames before calling this (it has
// no way to know about other grids) - sharedCompanyNames covers those
// instead, via untagCompaniesFromGrid above.
app.delete('/api/grid', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactNames = [], companyNames = [], sharedCompanyNames = [], gridName } = req.body || {};

  try {
    const contactIds = (await Promise.all(
      contactNames.map(name => findRecordByFieldName('Contacts', 'Full Name', name))
    )).filter(Boolean).map(r => r.id);

    const companyIds = (await Promise.all(
      companyNames.map(name => findRecordByFieldName('Companies', 'Company Name', name))
    )).filter(Boolean).map(r => r.id);

    if (contactIds.length) await airtableBatchDelete('Contacts', contactIds);
    if (companyIds.length) await airtableBatchDelete('Companies', companyIds);
    await untagCompaniesFromGrid(gridName, sharedCompanyNames);

    res.json({ success: true, deletedContacts: contactIds.length, deletedCompanies: companyIds.length });
  } catch (err) {
    console.error('Grid delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== RESET GRID CONTACTS (Grid toolbar) =====================
// Grid toolbar's "Reset" button - wipes a grid's contacts (and their
// Campaign Contacts rows) and companies from Airtable, but unlike DELETE
// /api/grid above, leaves the Grids record itself alone so the grid's name
// and columns survive and the board just comes back empty. Same
// client-resolves-the-names approach as DELETE /api/grid, since Airtable has
// no per-grid field on Contacts (see the "gridName" note on
// createOrUpdateAirtableContact) - the client already excludes any
// companyNames shared with another grid before calling this, passing them
// as sharedCompanyNames instead so untagCompaniesFromGrid can drop just
// this grid's name off them (see DELETE /api/grid above for why leaving it
// there is a real bug, not a cosmetic one).
app.delete('/api/grids/:gridId/contacts', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });

  const { contactNames = [], companyNames = [], sharedCompanyNames = [], gridName } = req.body || {};

  try {
    const contactIds = (await Promise.all(
      contactNames.map(name => findRecordByFieldName('Contacts', 'Full Name', name))
    )).filter(Boolean).map(r => r.id);

    const companyIds = (await Promise.all(
      companyNames.map(name => findRecordByFieldName('Companies', 'Company Name', name))
    )).filter(Boolean).map(r => r.id);

    // Campaign Contacts rows have no per-grid field either - found the same
    // way as every other place in this file that needs "every Campaign
    // Contacts row for a given Contact", by filtering the whole table's
    // Contact link field against the contact ids resolved above.
    let deletedCampaignContacts = 0;
    if (contactIds.length) {
      const contactIdSet = new Set(contactIds);
      const ccRows = await airtableFetchAllRecords(CAMPAIGN_CONTACTS_TABLE);
      const ccIdsToDelete = ccRows
        .filter(r => (r.fields['Contact'] || []).some(cid => contactIdSet.has(cid)))
        .map(r => r.id);
      if (ccIdsToDelete.length) {
        await airtableBatchDelete(CAMPAIGN_CONTACTS_TABLE, ccIdsToDelete);
        deletedCampaignContacts = ccIdsToDelete.length;
      }
    }

    if (contactIds.length) await airtableBatchDelete('Contacts', contactIds);
    if (companyIds.length) await airtableBatchDelete('Companies', companyIds);
    await untagCompaniesFromGrid(gridName, sharedCompanyNames);

    res.json({
      success: true,
      deletedContacts: contactIds.length,
      deletedCompanies: companyIds.length,
      deletedCampaignContacts
    });
  } catch (err) {
    console.error('Grid contacts reset error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== SEO CONTENT ENGINE =====================
// Marketing tab > SEO sub-tab: a Ubersuggest keyword library, an SEO voice
// profile (a dedicated field on the Settings singleton, separate from the
// LinkedIn/blog voice profile on Content Settings above), Serper+Claude
// blog post generation against an on-page SEO checklist, and sending the
// result to Framer's CMS as a draft item via the real "framer-api" Server
// API SDK (see publishToFramer below - it's a stateful connect/addItems
// session, not a plain REST POST, so this file's usual airtableRequest-
// style fetch() wrapper doesn't apply to it. It deliberately never calls
// the SDK's site-wide publish() - see that function's comment for why).

const KEYWORDS_TABLE = 'Keywords';
const SITEMAP_TABLE = 'Sitemap';

const DEFAULT_SEO_VOICE_PROFILE = `Twenty2 Collective (T2C) is a Perth, WA-based Agile and change consultancy. Write with authority and practical insight for corporate professionals - programme leads, transformation execs, PMO heads - who are tired of theory and want what actually works on the ground. Tone: direct, no jargon for its own sake, occasional dry humour, always backed by a concrete example, stat, or story from real client work. T2C has opinions: Agile theatre without genuine behaviour change wastes a budget; most transformation failures are change management failures, not process failures; frameworks are a starting point, not a religion. UK/AU English, no em dashes.`;

// ---- Airtable schema provisioning ----
// airtableRequest's typecast:true only converts a value into an *existing*
// field's type (and, for single selects, adds a new option) - it never
// creates a table or field that isn't there yet. The Keywords/Sitemap
// tables and the Settings.SEO Voice Profile field are provisioned on first
// use via Airtable's separate Metadata API, which needs the connected PAT
// to carry the schema.bases:write scope in addition to the data scopes
// this file already relies on elsewhere - if it doesn't, these throw with
// Airtable's own permission error text surfaced straight to the caller.
const AIRTABLE_META_URL = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}`;
let airtableSchemaCache = null;

async function fetchAirtableSchema(force) {
  if (airtableSchemaCache && !force) return airtableSchemaCache;
  const res = await airtableFetchWithRetry(`${AIRTABLE_META_URL}/tables`, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Airtable schema fetch error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  airtableSchemaCache = data.tables || [];
  return airtableSchemaCache;
}

async function ensureAirtableTable(tableName, fields) {
  const tables = await fetchAirtableSchema();
  let table = tables.find(t => t.name === tableName);
  if (table) return table;
  const res = await airtableFetchWithRetry(`${AIRTABLE_META_URL}/tables`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tableName, fields })
  });
  if (!res.ok) throw new Error(`Could not create Airtable table "${tableName}": ${res.status} ${await res.text()}`);
  table = await res.json();
  airtableSchemaCache = null;
  return table;
}

async function ensureAirtableField(tableName, fieldName, fieldDef) {
  const tables = await fetchAirtableSchema();
  const table = tables.find(t => t.name === tableName);
  if (!table) throw new Error(`Airtable table "${tableName}" not found`);
  if (table.fields.some(f => f.name === fieldName)) return;
  const res = await airtableFetchWithRetry(`${AIRTABLE_META_URL}/tables/${table.id}/fields`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fieldName, ...fieldDef })
  });
  if (!res.ok) throw new Error(`Could not create field "${fieldName}" on "${tableName}": ${res.status} ${await res.text()}`);
  airtableSchemaCache = null;
}

// Provisioning the Keywords/Sitemap tables and the SEO Voice Profile field
// is best-effort, not a hard requirement: it needs the connected Airtable
// token to carry schema.bases:write (most tokens don't, by default), and
// the tables/field can just as well be created once by hand in the
// Airtable UI instead - using the exact names/types below - with no
// schema scope needed at all afterwards. So every ensure* call here
// swallows its own error and logs a warning rather than throwing: if the
// table/field already exists (created either way), the calling route's
// actual record read/write proceeds normally; if it doesn't exist and
// can't be auto-created, that read/write fails on its own with a normal
// "table not found" Airtable error instead of this step blocking it pre-emptively.
// Reuses the Keywords table that already existed in this base before this
// feature (Keyword/Volume/KD/Intent/Status/Content/Related Companies/
// Notes/AI Keyword Opportunity Score - built for the same kind of keyword/
// content work, just not by this app's code). Content holds the generated
// post's HTML and Notes holds the suggested-keyword reason, rather than
// adding separate Post HTML / Suggested Reason fields that would duplicate
// them. Related Companies and AI Keyword Opportunity Score aren't read or
// written by this feature. This field list only matters if the table needs
// to be created from scratch (it doesn't exist here, but keeps
// ensureKeywordsTable correct for a from-fresh base).
async function ensureKeywordsTable() {
  try {
    return await ensureAirtableTable(KEYWORDS_TABLE, [
      { name: 'Keyword', type: 'singleLineText' },
      { name: 'Volume', type: 'number', options: { precision: 0 } },
      { name: 'KD', type: 'number', options: { precision: 0 } },
      { name: 'Intent', type: 'singleLineText' },
      { name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'Queued' }, { name: 'Generating' }, { name: 'Generated' }, { name: 'Published' }] } },
      { name: 'Post Title', type: 'singleLineText' },
      { name: 'Content', type: 'multilineText' },
      { name: 'Meta Title', type: 'singleLineText' },
      { name: 'Meta Description', type: 'multilineText' },
      { name: 'Published URL', type: 'url' },
      { name: 'Notes', type: 'multilineText' },
      { name: 'Created Date', type: 'date', options: { dateFormat: { name: 'iso' } } }
    ]);
  } catch (err) {
    console.warn('Could not auto-provision the Keywords table (create it by hand if it does not exist yet):', err.message);
  }
}

async function ensureSitemapTable() {
  try {
    return await ensureAirtableTable(SITEMAP_TABLE, [
      { name: 'URL', type: 'url' },
      { name: 'Title', type: 'singleLineText' },
      { name: 'Published Date', type: 'date', options: { dateFormat: { name: 'iso' } } },
      { name: 'Keyword', type: 'singleLineText' }
    ]);
  } catch (err) {
    console.warn('Could not auto-provision the Sitemap table (create it by hand if it does not exist yet):', err.message);
  }
}

async function ensureSeoVoiceProfileField() {
  try {
    return await ensureAirtableField(SETTINGS_TABLE, 'SEO Voice Profile', { type: 'multilineText' });
  } catch (err) {
    console.warn('Could not auto-provision the SEO Voice Profile field (add it by hand if it does not exist yet):', err.message);
  }
}

function getSeoVoiceProfileText(settingsFields) {
  const v = settingsFields && settingsFields['SEO Voice Profile'];
  return v && v.trim() ? v : DEFAULT_SEO_VOICE_PROFILE;
}

app.get('/api/seo/voice-profile', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    const record = await getSettingsRecord();
    const voiceProfile = (record && record.fields['SEO Voice Profile']) || '';
    res.json({ voiceProfile, defaultVoiceProfile: DEFAULT_SEO_VOICE_PROFILE });
  } catch (err) {
    console.error('Get SEO voice profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/seo/voice-profile', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { voiceProfile } = req.body;
  try {
    await ensureSeoVoiceProfileField();
    const settingsRecord = await getOrCreateSettingsRecord();
    await airtableRequest('PATCH', SETTINGS_TABLE, {
      records: [{ id: settingsRecord.id, fields: { 'SEO Voice Profile': voiceProfile || '' } }],
      typecast: true
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Save SEO voice profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Keyword library ----

app.post('/api/seo/keywords/import', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  try {
    await ensureKeywordsTable();
    const existing = await airtableFetchAllRecords(KEYWORDS_TABLE);
    const existingKeywords = new Set(existing.map(r => (r.fields['Keyword'] || '').toLowerCase().trim()));
    const today = new Date().toISOString().slice(0, 10);
    const seenInFile = new Set();
    const toCreate = [];
    rows.forEach(r => {
      const keyword = (r.keyword || '').trim();
      if (!keyword) return;
      const key = keyword.toLowerCase();
      if (existingKeywords.has(key) || seenInFile.has(key)) return;
      seenInFile.add(key);
      toCreate.push({
        fields: {
          'Keyword': keyword,
          'Volume': Number(r.volume) || 0,
          'KD': Number(r.kd) || 0,
          'Intent': r.intent || '',
          'Status': 'Queued',
          'Created Date': today
        }
      });
    });
    for (let i = 0; i < toCreate.length; i += 10) {
      await airtableRequest('POST', KEYWORDS_TABLE, { records: toCreate.slice(i, i + 10), typecast: true });
    }
    res.json({ success: true, created: toCreate.length, skipped: rows.length - toCreate.length });
  } catch (err) {
    console.error('Import SEO keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/seo/keywords', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  try {
    await ensureKeywordsTable();
    const records = await airtableFetchAllRecords(KEYWORDS_TABLE);
    const keywords = records
      .map(r => ({
        id: r.id,
        keyword: r.fields['Keyword'] || '',
        volume: r.fields['Volume'] || 0,
        kd: r.fields['KD'] || 0,
        intent: r.fields['Intent'] || '',
        status: r.fields['Status'] || 'Queued',
        postTitle: r.fields['Post Title'] || '',
        postHtml: r.fields['Content'] || '',
        metaTitle: r.fields['Meta Title'] || '',
        metaDescription: r.fields['Meta Description'] || '',
        publishedUrl: r.fields['Published URL'] || '',
        suggestedReason: r.fields['Notes'] || '',
        createdDate: r.fields['Created Date'] || ''
      }))
      .sort((a, b) => (b.volume || 0) - (a.volume || 0));
    res.json({ keywords });
  } catch (err) {
    console.error('List SEO keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/seo/keywords/:id/save', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { title, html, metaTitle, metaDescription } = req.body;
  try {
    const fields = {};
    if (title !== undefined) fields['Post Title'] = title;
    if (html !== undefined) fields['Content'] = html;
    if (metaTitle !== undefined) fields['Meta Title'] = metaTitle;
    if (metaDescription !== undefined) fields['Meta Description'] = metaDescription;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to save' });
    await airtableRequest('PATCH', KEYWORDS_TABLE, { records: [{ id: req.params.id, fields }], typecast: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Save SEO post edits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/seo/keywords/add-to-queue', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  const { keyword, reason } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });
  try {
    await ensureKeywordsTable();
    const existing = await airtableFetchAllRecords(KEYWORDS_TABLE);
    if (existing.some(r => (r.fields['Keyword'] || '').toLowerCase().trim() === keyword.toLowerCase().trim())) {
      return res.status(409).json({ error: 'That keyword is already in the library' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const data = await airtableRequest('POST', KEYWORDS_TABLE, {
      records: [{ fields: { 'Keyword': keyword.trim(), 'Status': 'Queued', 'Notes': reason || '', 'Created Date': today } }],
      typecast: true
    });
    res.json({ success: true, id: data.records[0].id });
  } catch (err) {
    console.error('Add SEO keyword to queue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Suggested keywords ----
// Same "mine recent logged activity with Claude" shape as
// detectContentSignals() above, but pointed at Touch Points + Research
// Events (CVC responses) + Contacts.Job Change Signal instead of Touch
// Points + Deals, and returning keyword ideas rather than content themes.

app.get('/api/seo/suggest-keywords', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const [tpRecords, researchRecords, contactRecords] = await Promise.all([
      airtableFetchAllRecords('Touch Points'),
      airtableFetchAllRecords('Research Events'),
      airtableFetchAllRecords('Contacts')
    ]);

    const recentTouchPoints = tpRecords
      .filter(r => r.fields['Summary'])
      .sort((a, b) => new Date(b.fields['Date'] || 0) - new Date(a.fields['Date'] || 0))
      .slice(0, 50)
      .map(r => r.fields['Summary']);

    const cvcInsights = researchRecords
      .map(r => [r.fields['Extracted Themes'], r.fields['Key Pain Points'], r.fields['Hot Topics']].filter(Boolean).join(' | '))
      .filter(Boolean);

    const jobChangeSignals = contactRecords
      .filter(r => r.fields['Job Change Signal'])
      .map(r => r.fields['Job Change Signal']);

    if (!recentTouchPoints.length && !cvcInsights.length && !jobChangeSignals.length) {
      return res.json({ suggestions: [] });
    }

    const prompt = `You are an SEO content strategist for T2C Outreach, Twenty2 Collective, a Perth-based Agile and change consultancy.

Analyse this real activity from the CRM to find blog keyword opportunities:

RECENT TOUCH POINT NOTES (${recentTouchPoints.length}):
${JSON.stringify(recentTouchPoints)}

CVC / RESEARCH EVENT INSIGHTS (${cvcInsights.length}):
${JSON.stringify(cvcInsights)}

JOB CHANGE SIGNALS (${jobChangeSignals.length}):
${JSON.stringify(jobChangeSignals)}

Identify the language, pain points, and topics being discussed, and suggest 5-10 blog post keywords that would resonate with this audience and have plausible search intent. For each, give a one-line explanation of why it's relevant based on what you found above.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "suggestions": [ { "keyword": string, "reason": string } ] }`;

    const parsed = await callClaudeJson(prompt, 2000);
    res.json({ suggestions: parsed.suggestions || [] });
  } catch (err) {
    console.error('Suggest SEO keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Post generation ----

async function serperSearchTop(query, num) {
  const serperRes = await fetch(SERPER_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: num || 10 })
  });
  if (!serperRes.ok) throw new Error(`Serper API error: ${serperRes.status}`);
  const data = await serperRes.json();
  return data.organic || [];
}

async function serperScrapePage(url) {
  const scrapeRes = await fetch('https://scrape.serper.dev', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!scrapeRes.ok) throw new Error(`Serper scrape error: ${scrapeRes.status}`);
  return scrapeRes.json();
}

// Serper's scrape response shape isn't documented to a fixed schema (same
// uncertainty already flagged on the LinkedIn org id scrape route above) -
// this reads whichever of text/html/markdown came back and is defensive
// about all of them, since it's only used for a rough structural summary
// (heading list + word count), not exact reproduction.
function summarizeScrapedPage(url, scraped) {
  const text = scraped.text || scraped.markdown || '';
  const html = scraped.html || '';
  const wordCount = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const headings = [];
  if (html) {
    const headingMatches = html.matchAll(/<h([1-3])[^>]*>(.*?)<\/h\1>/gis);
    for (const m of headingMatches) {
      const cleaned = m[2].replace(/<[^>]+>/g, '').trim();
      if (cleaned) headings.push({ level: Number(m[1]), text: cleaned });
    }
  }
  return { url, title: scraped.title || '', wordCount, headings: headings.slice(0, 40) };
}

const SEO_CHECKLIST = `Apply this on-page SEO checklist:
1. Primary keyword in the H1
2. Primary keyword in the meta title
3. Primary keyword in the meta description
4. Primary keyword in the first paragraph (within the first 100 words)
5. At least 3 subheadings (H2/H3) beyond the H1
6. A keyword cluster of 5-8 closely related terms woven naturally throughout, not just the primary keyword repeated
7. Natural keyword density between 1-2% for the primary keyword
8. Exactly one H1, multiple H2s, and H3s nested under relevant H2s where useful
9. 2-3 internal links to other T2C blog posts, as placeholder URLs like /blog/related-post-slug
10. 2-3 external links to real, relevant, authoritative outside sources
11. An FAQ section with 4-6 questions targeting related search queries, each with a real answer
12. A clear call to action at the end, pointing to a specific T2C service
13. Meta title under 60 characters
14. Meta description under 160 characters`;

async function generateSeoPostForKeyword(keywordRecord) {
  const keyword = keywordRecord.fields['Keyword'];

  const organic = await serperSearchTop(keyword, 10);
  const topResults = organic.slice(0, 3);

  const scrapedSummaries = [];
  for (const result of topResults) {
    try {
      const scraped = await serperScrapePage(result.link);
      scrapedSummaries.push(summarizeScrapedPage(result.link, scraped));
    } catch (err) {
      console.warn('SEO scrape failed for', result.link, '-', err.message);
      scrapedSummaries.push({ url: result.link, title: result.title || '', wordCount: 0, headings: [], scrapeFailed: true });
    }
  }

  const settingsRecord = await getSettingsRecord();
  const voiceProfile = getSeoVoiceProfileText(settingsRecord ? settingsRecord.fields : {});

  const avgWordCount = scrapedSummaries.length
    ? Math.round(scrapedSummaries.reduce((sum, s) => sum + (s.wordCount || 0), 0) / scrapedSummaries.length)
    : 1200;

  const prompt = `You are writing an SEO blog post for T2C Outreach, Twenty2 Collective.

VOICE PROFILE:
${voiceProfile}

PRIMARY KEYWORD: "${keyword}"

TOP-RANKING PAGES FOR THIS KEYWORD (match the average structure and topic coverage of these):
${scrapedSummaries.map((s, i) => `${i + 1}. ${s.url}${s.title ? ' - "' + s.title + '"' : ''}
   Approx word count: ${s.wordCount || 'unknown'}
   Headings: ${s.headings.length ? s.headings.map(h => `H${h.level}: ${h.text}`).join(' | ') : 'not extracted'}`).join('\n\n')}

Average competitor length: approximately ${avgWordCount} words - write to a similar length.

${SEO_CHECKLIST}

Write a full SEO blog post as clean HTML - a single string of HTML using h1/h2/h3/p/ul/li/a tags, no <html>/<head>/<body> wrapper and no <img> tags (images are added manually after generation). Internal links: <a href="/blog/relevant-slug">. External links: <a href="..." target="_blank" rel="noopener"> to real, well-known, relevant domains. UK/AU English, no em dashes, in T2C's voice as described above.

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "title": string, "html": string, "metaTitle": string (under 60 characters), "metaDescription": string (under 160 characters) }`;

  const drafted = await callClaudeJson(prompt, 8000);
  const html = await ensureValidSeoHeadings(drafted.html || '', keyword);

  return {
    title: drafted.title || keyword,
    html,
    metaTitle: (drafted.metaTitle || '').slice(0, 60),
    metaDescription: (drafted.metaDescription || '').slice(0, 160)
  };
}

// Checklist item 8/9 ("exactly one H1, multiple H2s") is a prompt
// instruction above, not a guarantee - models occasionally skip it (no H1,
// two H1s, or only one H2). This actually checks the returned HTML by
// counting tags and, if it's wrong, sends it back to Claude for a single
// targeted heading-structure fix pass (content/wording/links untouched)
// rather than a full regeneration. If the fix pass still doesn't come back
// valid, the best attempt is used anyway and a warning is logged - the
// preview panel's editable HTML textarea is the final backstop before
// anything reaches Framer.
function countHtmlTag(html, tag) {
  const matches = html.match(new RegExp(`<${tag}[ >]`, 'gi'));
  return matches ? matches.length : 0;
}

function validateSeoHeadings(html) {
  const h1Count = countHtmlTag(html, 'h1');
  const h2Count = countHtmlTag(html, 'h2');
  const problems = [];
  if (h1Count !== 1) problems.push(`${h1Count} <h1> tags found - must be exactly 1`);
  if (h2Count < 2) problems.push(`only ${h2Count} <h2> tag(s) found - must be at least 2`);
  return { valid: problems.length === 0, problems };
}

async function ensureValidSeoHeadings(html, keyword) {
  const validation = validateSeoHeadings(html);
  if (validation.valid) return html;

  console.warn(`SEO post for "${keyword}" failed heading validation (${validation.problems.join('; ')}) - retrying with a heading fix pass`);
  const fixPrompt = `This HTML blog post's heading structure is wrong: ${validation.problems.join('; ')}.

Fix ONLY the heading structure - keep all the actual wording, links, images, and FAQ content the same. Requirements: exactly one <h1> containing the primary keyword "${keyword}", followed by multiple <h2> subheadings (with <h3> nested under them where useful), no other top-level heading tags.

HTML to fix:
---
${html}
---

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{ "html": string }`;

  try {
    const fixed = await callClaudeJson(fixPrompt, 8000);
    if (!fixed.html) return html;
    const revalidation = validateSeoHeadings(fixed.html);
    if (!revalidation.valid) {
      console.warn(`SEO post for "${keyword}" still failed heading validation after the fix pass (${revalidation.problems.join('; ')}) - using it anyway, review before sending to Framer`);
    }
    return fixed.html;
  } catch (err) {
    console.warn('SEO heading fix pass failed, keeping original html:', err.message);
    return html;
  }
}

app.post('/api/seo/generate-post', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not configured' });

  const { keywordId } = req.body;
  if (!keywordId) return res.status(400).json({ error: 'keywordId is required' });

  try {
    await ensureKeywordsTable();
    const keywordRecord = await airtableGetRecord(KEYWORDS_TABLE, keywordId);
    if (!keywordRecord) return res.status(404).json({ error: 'Keyword not found' });

    airtableRequest('PATCH', KEYWORDS_TABLE, { records: [{ id: keywordId, fields: { 'Status': 'Generating' } }], typecast: true })
      .catch(err => console.warn('Could not mark keyword Generating:', err.message));

    const post = await generateSeoPostForKeyword(keywordRecord);

    await airtableRequest('PATCH', KEYWORDS_TABLE, {
      records: [{
        id: keywordId,
        fields: {
          'Post Title': post.title,
          'Content': post.html,
          'Meta Title': post.metaTitle,
          'Meta Description': post.metaDescription,
          'Status': 'Generated'
        }
      }],
      typecast: true
    });

    res.json({ success: true, keywordId, title: post.title, html: post.html, metaTitle: post.metaTitle, metaDescription: post.metaDescription, status: 'Generated' });
  } catch (err) {
    console.error('Generate SEO post error:', err.message);
    airtableRequest('PATCH', KEYWORDS_TABLE, { records: [{ id: keywordId, fields: { 'Status': 'Queued' } }], typecast: true })
      .catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ---- Send to Framer (as a draft) ----
// Framer's CMS write path is a stateful Server API connection, not a plain
// REST POST: the "framer-api" npm package (ESM-only, hence the dynamic
// import from this CommonJS file) opens a session with connect(), and
// collection.addItems() runs over it before disconnect(). Deliberately
// never calls framer.publish() - that deploys the whole site, and the
// brief is explicit that generated posts must land as a draft for someone
// to review, not go live automatically. Instead, the new CMS item's own
// Status field (an enum field on the Blog collection - confirmed against
// the real T2C base, values include "Live") is set to whichever case name
// matches /draft/i, so it shows up in Framer's CMS table the same way a
// manually-created draft post would. If that field or a matching case
// isn't found, the item is still created without a status - never blocks
// the whole write over it.
//
// Every other field is matched by name (case-insensitive substring) via
// FRAMER_FIELD_ALIASES below - the same defensive, schema-not-fully-
// confirmed approach this file already uses for the LinkedIn org id scrape
// route. Requires FRAMER_API_KEY and FRAMER_PROJECT_URL (the project URL
// from Framer's own address bar, without any ?node=/&view= query string -
// e.g. "https://framer.com/projects/Website--aabbccdd1122") in the
// environment. FRAMER_SITE_URL (the live domain) and
// FRAMER_BLOG_PATH_PREFIX (the collection's page path, e.g. "/research" -
// confirmed against an existing T2C post's URL, may differ per project) are
// used only to build the preview URL shown in the UI; FRAMER_BLOG_COLLECTION_NAME
// picks the collection by exact name when a project has more than one.

const FRAMER_FIELD_ALIASES = {
  title: ['title', 'name', 'headline'],
  content: ['content', 'body', 'post', 'article'],
  metaTitle: ['meta title', 'seo title'],
  metaDescription: ['meta description', 'seo description', 'excerpt', 'summary'],
  status: ['status']
};

function findFramerField(fields, aliasKey) {
  const aliases = FRAMER_FIELD_ALIASES[aliasKey] || [];
  return fields.find(f => aliases.some(alias => f.name.toLowerCase().includes(alias)));
}

function slugifyForFramer(title) {
  const slug = (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
  return slug || `post-${Date.now()}`;
}

async function publishToFramer(post) {
  const { connect } = await import('framer-api');
  const framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
  try {
    const collections = await framer.getCollections();
    if (!collections.length) throw new Error('No CMS collections found in the connected Framer project');
    const nameHint = process.env.FRAMER_BLOG_COLLECTION_NAME;
    const collection = (nameHint && collections.find(c => c.name.toLowerCase() === nameHint.toLowerCase()))
      || collections.find(c => /blog|post|article/i.test(c.name))
      || collections[0];

    const fields = await collection.getFields();
    const titleField = findFramerField(fields, 'title');
    const contentField = findFramerField(fields, 'content');
    const metaTitleField = findFramerField(fields, 'metaTitle');
    const metaDescField = findFramerField(fields, 'metaDescription');
    const statusField = findFramerField(fields, 'status');

    const fieldData = {};
    if (titleField) fieldData[titleField.id] = { type: 'string', value: post.title };
    if (contentField) fieldData[contentField.id] = { type: 'formattedText', value: post.html, contentType: 'html' };
    if (metaTitleField) fieldData[metaTitleField.id] = { type: 'string', value: post.metaTitle };
    if (metaDescField) fieldData[metaDescField.id] = { type: 'string', value: post.metaDescription };
    if (statusField && statusField.type === 'enum') {
      const draftCase = statusField.cases.find(c => /draft/i.test(c.name));
      if (draftCase) fieldData[statusField.id] = { type: 'enum', value: draftCase.id };
      else console.warn('Framer Status field has no "Draft" case - post created without a status');
    }

    const slug = slugifyForFramer(post.title);
    await collection.addItems([{ slug, fieldData }]);
    // No framer.publish() call - the item exists in the CMS as a draft
    // (Status set above, if the field/case were found) until a human
    // reviews it and presses Publish in the Framer UI themselves.

    const siteUrl = (process.env.FRAMER_SITE_URL || '').replace(/\/$/, '');
    const pathPrefix = (process.env.FRAMER_BLOG_PATH_PREFIX || '/research').replace(/\/$/, '');
    const url = siteUrl ? `${siteUrl}${pathPrefix}/${slug}` : slug;
    return { url, slug, collectionName: collection.name };
  } finally {
    await framer.disconnect();
  }
}

// Read-only connection check - connects, resolves the target collection
// and its fields, then disconnects without writing anything. Exists so the
// Framer env vars (API key, project URL, collection name) can be verified
// after a Railway deploy without creating a real draft post as a side
// effect of testing.
app.get('/api/seo/framer-status', async (req, res) => {
  if (!process.env.FRAMER_API_KEY) return res.status(500).json({ error: 'FRAMER_API_KEY not configured' });
  if (!process.env.FRAMER_PROJECT_URL) return res.status(500).json({ error: 'FRAMER_PROJECT_URL not configured' });

  let framer;
  try {
    const { connect } = await import('framer-api');
    framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);

    const info = await framer.getProjectInfo();
    const collections = await framer.getCollections();
    if (!collections.length) return res.json({ connected: true, projectName: info.name, error: 'No CMS collections found in this project' });

    const nameHint = process.env.FRAMER_BLOG_COLLECTION_NAME;
    const collection = (nameHint && collections.find(c => c.name.toLowerCase() === nameHint.toLowerCase()))
      || collections.find(c => /blog|post|article/i.test(c.name))
      || collections[0];

    const fields = await collection.getFields();
    const statusField = findFramerField(fields, 'status');

    res.json({
      connected: true,
      projectName: info.name,
      allCollectionNames: collections.map(c => c.name),
      resolvedCollection: collection.name,
      resolvedByExactNameMatch: !!(nameHint && collection.name.toLowerCase() === nameHint.toLowerCase()),
      fields: fields.map(f => ({ name: f.name, type: f.type })),
      matchedFields: {
        title: findFramerField(fields, 'title') ? findFramerField(fields, 'title').name : null,
        content: findFramerField(fields, 'content') ? findFramerField(fields, 'content').name : null,
        metaTitle: findFramerField(fields, 'metaTitle') ? findFramerField(fields, 'metaTitle').name : null,
        metaDescription: findFramerField(fields, 'metaDescription') ? findFramerField(fields, 'metaDescription').name : null,
        status: statusField ? statusField.name : null
      },
      statusFieldCases: (statusField && statusField.type === 'enum') ? statusField.cases.map(c => c.name) : null,
      draftCaseFound: (statusField && statusField.type === 'enum') ? !!statusField.cases.find(c => /draft/i.test(c.name)) : null
    });
  } catch (err) {
    console.error('Framer status check error:', err.message);
    res.status(500).json({ connected: false, error: err.message });
  } finally {
    if (framer) await framer.disconnect().catch(() => {});
  }
});

// "Published" here (route name, Keywords.Status, Sitemap.Published Date)
// tracks that the post was sent to Framer's CMS as a draft item - not that
// it's live. Going live is a separate, manual step the reviewer takes in
// Framer itself (see publishToFramer's comment above).
app.post('/api/seo/publish', async (req, res) => {
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
  if (!process.env.FRAMER_API_KEY) return res.status(500).json({ error: 'FRAMER_API_KEY not configured' });
  if (!process.env.FRAMER_PROJECT_URL) return res.status(500).json({ error: 'FRAMER_PROJECT_URL not configured' });

  const { keywordId } = req.body;
  if (!keywordId) return res.status(400).json({ error: 'keywordId is required' });

  try {
    await ensureKeywordsTable();
    await ensureSitemapTable();
    const keywordRecord = await airtableGetRecord(KEYWORDS_TABLE, keywordId);
    if (!keywordRecord) return res.status(404).json({ error: 'Keyword not found' });
    const kf = keywordRecord.fields;
    if (!kf['Content']) return res.status(400).json({ error: 'This keyword has no generated post to publish yet' });

    const post = {
      title: kf['Post Title'] || kf['Keyword'],
      html: kf['Content'],
      metaTitle: kf['Meta Title'] || '',
      metaDescription: kf['Meta Description'] || ''
    };

    const published = await publishToFramer(post);
    const today = new Date().toISOString().slice(0, 10);

    await airtableRequest('POST', SITEMAP_TABLE, {
      records: [{ fields: { 'URL': published.url, 'Title': post.title, 'Published Date': today, 'Keyword': kf['Keyword'] || '' } }],
      typecast: true
    });

    await airtableRequest('PATCH', KEYWORDS_TABLE, {
      records: [{ id: keywordId, fields: { 'Status': 'Published', 'Published URL': published.url } }],
      typecast: true
    });

    res.json({ success: true, url: published.url });
  } catch (err) {
    console.error('Publish SEO post error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== SCHEDULED SYNC JOBS =====================
// Both run silently in the background and never block the UI - failures
// are logged, not thrown, same as every other cron-eligible job in this
// file (detectContentSignals, etc).

// Daily 6am: Trigify contact post sync + post-based job change detection,
// the Job Change Monitor keyword search, and the offer learning-loop
// metrics sweep - unrelated jobs that just happen to share a daily cadence.
cron.schedule('0 6 * * *', () => {
  syncTrigifyContactPosts().catch(err => console.warn('Scheduled Trigify contact sync failed:', err.message));
  syncJobChangeMonitorSignals().catch(err => console.warn('Scheduled job change monitor sync failed:', err.message));
  updateAllOfferMetrics().catch(err => console.warn('Scheduled offer metrics update failed:', err.message));
});

// Weekly Sunday 7am: Serper-based job title drift detection.
cron.schedule('0 7 * * 0', () => {
  checkContactJobChanges().catch(err => console.warn('Scheduled job change check failed:', err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
