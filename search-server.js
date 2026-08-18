const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const SERPER_URL = 'https://google.serper.dev/search';

function extractName(title){
  if(!title) return '';
  return title.split(' - ')[0].split(' | ')[0].trim();
}

function isConfidentMatch(result, companyWords, titleWords){
  if(!result.link || !result.link.includes('linkedin.com/in/')) return false;
  const haystack = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
  const hasTitle = titleWords.every(w => haystack.includes(w));
  const hasCompany = companyWords.some(w => w.length > 2 && haystack.includes(w));
  return hasTitle && hasCompany;
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
  res.json({ status: 'ok', service: 'twenty2-search-server' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Search server listening on port ${PORT}`));
