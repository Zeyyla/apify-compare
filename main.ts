import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import OpenAI from 'openai';

// ============ TYPES ============
interface Input {
    query: string;
    maxActors?: number;
}

interface ActorCandidate {
    id: string;
    name: string;
    username: string;
    title: string;
    description: string;
    url: string;
    stats: {
        totalUsers: number;
        totalRuns: number;
        lastRunStartedAt?: string;
    };
    version?: string;
    isDeprecated?: boolean;
    categories: string[];
    // Fetched from page
    readme?: string;
    pricing?: string;
    inputSchema?: string;
    outputFields?: string;
    lastUpdated?: string;
}

interface EvaluationScores {
    intentMatch: number;      // 1-10: Does I/O match user needs?
    documentation: number;    // 1-10: README quality
    pricing: number;          // 1-10: Cost effectiveness
    reliability: number;      // 1-10: Success rate, error-free
    maintenance: number;      // 1-10: Recently updated, active
    communityTrust: number;   // 1-10: Users, runs, social proof
    inputComplexity: number;  // 1-10: Ease of use (10 = very easy)
}

interface EvaluationResult {
    rank: number;
    actorId: string;
    actorName: string;
    actorUrl: string;
    username: string;
    scores: EvaluationScores;
    overallScore: number;
    strengths: string[];
    weaknesses: string[];
    summary: string;
    recommendation: string;
}

// ============ CONSTANTS ============
const MODEL = 'google/gemini-2.5-flash';
const WEIGHTS = {
    intentMatch: 0.30,
    documentation: 0.15,
    pricing: 0.15,
    reliability: 0.20,
    maintenance: 0.10,
    communityTrust: 0.05,
    inputComplexity: 0.05,
};

// ============ MAIN ============
await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.query) {
    throw new Error('Query is required');
}

const { query, maxActors = 5 } = input;
const startTime = Date.now();

log.info('🔍 Starting Actor Scout', { query, maxActors });

// Step 1: Extract search terms from query
log.info('Step 1: Analyzing query...');
const searchTerms = await extractSearchTerms(query);
log.info('Search terms extracted', { searchTerms });

// Step 2: Search Apify Store
log.info('Step 2: Searching Apify Store...');
const candidates = await searchApifyStore(searchTerms, maxActors * 2);
log.info(`Found ${candidates.length} candidates`);

// Step 3: Fetch detailed info (README, pricing, schemas)
log.info('Step 3: Fetching Actor details...');
const detailedCandidates = await fetchActorDetails(candidates.slice(0, maxActors + 2));

// Step 4: Evaluate each Actor with LLM
log.info('Step 4: Evaluating Actors...');
const evaluations = await evaluateActors(detailedCandidates, query);

// Step 5: Rank and format output
const ranked = evaluations
    .sort((a, b) => b.overallScore - a.overallScore)
    .slice(0, maxActors)
    .map((e, i) => ({ ...e, rank: i + 1 }));

// Generate formatted output
const duration = ((Date.now() - startTime) / 1000).toFixed(1);
const output = formatOutput(query, ranked, duration);

// Save results
await Actor.setValue('OUTPUT', {
    query,
    results: ranked,
    formattedOutput: output,
    metadata: {
        evaluatedCount: ranked.length,
        duration: `${duration}s`,
        model: MODEL,
        generatedAt: new Date().toISOString(),
    },
});

// Also push to dataset for easy export
await Actor.pushData(ranked);

// Log the formatted output
console.log('\n' + output);

log.info('✅ Actor Scout complete!', { 
    topPick: ranked[0]?.actorName,
    duration: `${duration}s` 
});

await Actor.exit();

// ============ HELPER FUNCTIONS ============

function getOpenAI(): OpenAI {
    return new OpenAI({
        baseURL: 'https://openrouter.apify.actor/api/v1',
        apiKey: 'apify',
        defaultHeaders: {
            Authorization: `Bearer ${process.env.APIFY_TOKEN}`,
        },
    });
}

async function extractSearchTerms(query: string): Promise<string[]> {
    const openai = getOpenAI();
    
    const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
            role: 'user',
            content: `Extract 2-4 search keywords to find Apify Actors for this request. Return ONLY a JSON array of strings.

Request: "${query}"

Examples:
- "scrape Amazon products" → ["amazon", "scraper", "products"]
- "extract LinkedIn profiles" → ["linkedin", "scraper", "profile"]

Return only the JSON array:`
        }],
        temperature: 0,
    });

    const content = response.choices[0]?.message?.content || '[]';
    try {
        const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        return query.toLowerCase().split(' ').filter(w => w.length > 3).slice(0, 4);
    }
}

async function searchApifyStore(terms: string[], limit: number): Promise<ActorCandidate[]> {
    const searchQuery = terms.join(' ');
    const url = `https://api.apify.com/v2/store?search=${encodeURIComponent(searchQuery)}&limit=${limit}&offset=0`;
    
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
    });
    
    if (!response.ok) {
        throw new Error(`Store API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.data.items.map((item: any) => ({
        id: item.id,
        name: item.name,
        username: item.username,
        title: item.title || item.name,
        description: item.description || '',
        url: `https://apify.com/${item.username}/${item.name}`,
        stats: {
            totalUsers: item.stats?.totalUsers || 0,
            totalRuns: item.stats?.totalRuns || 0,
            lastRunStartedAt: item.stats?.lastRunStartedAt,
        },
        version: item.version,
        isDeprecated: item.isDeprecated || false,
        categories: item.categories || [],
    }));
}

async function fetchActorDetails(actors: ActorCandidate[]): Promise<ActorCandidate[]> {
    const details = new Map<string, Partial<ActorCandidate>>();
    
    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: actors.length,
        requestHandler: async ({ request, $ }) => {
            const actorId = request.userData.actorId;
            
            // Extract README (try multiple selectors)
            let readme = '';
            const readmeSelectors = [
                '[data-testid="actor-readme"]',
                '.actor-readme', 
                'article',
                '.markdown-body'
            ];
            for (const sel of readmeSelectors) {
                const text = $(sel).first().text();
                if (text && text.length > 100) {
                    readme = text;
                    break;
                }
            }
            
            // Extract pricing info
            const pricingText = $('body').text();
            const pricingMatch = pricingText.match(/\$[\d.]+\s*(per|\/)\s*\d*\s*(result|run|item|request|1[,\d]*)/i);
            const pricing = pricingMatch ? pricingMatch[0] : 'See pricing tab';
            
            // Look for input schema hints
            const inputHints = $('input[type], select, textarea').length;
            
            details.set(actorId, {
                readme: readme.slice(0, 4000),
                pricing,
                inputSchema: `~${inputHints} input fields detected`,
            });
        },
        failedRequestHandler: async ({ request }) => {
            log.warning(`Failed to fetch: ${request.url}`);
        },
    });
    
    await crawler.run(
        actors.map(a => ({
            url: a.url,
            userData: { actorId: a.id },
        }))
    );
    
    return actors.map(actor => ({
        ...actor,
        ...details.get(actor.id),
    }));
}

async function evaluateActors(
    actors: ActorCandidate[], 
    userQuery: string
): Promise<EvaluationResult[]> {
    const openai = getOpenAI();
    const results: EvaluationResult[] = [];
    
    for (const actor of actors) {
        log.info(`Evaluating: ${actor.title}`);
        
        const prompt = `You are an Apify Actor evaluator. Score this Actor for the user's needs.

USER REQUEST: "${userQuery}"

ACTOR INFORMATION:
- Name: ${actor.title}
- Developer: ${actor.username}
- Description: ${actor.description}
- URL: ${actor.url}
- Total Users: ${actor.stats.totalUsers.toLocaleString()}
- Total Runs: ${actor.stats.totalRuns.toLocaleString()}
- Categories: ${actor.categories.join(', ') || 'None'}
- Pricing: ${actor.pricing || 'Unknown'}
- Is Deprecated: ${actor.isDeprecated}

README (excerpt):
${actor.readme?.slice(0, 2500) || 'No README available'}

SCORING CRITERIA (1-10 each):
1. intentMatch: Does the Actor's input/output match what the user needs?
2. documentation: Is the README clear, complete, with examples?
3. pricing: Is it cost-effective for the user's likely scale?
4. reliability: Does it seem stable? Any mention of errors/issues?
5. maintenance: Is it recently updated? Active development?
6. communityTrust: High user count? Many runs? Trusted developer?
7. inputComplexity: Is it easy to use? (10 = very simple, 1 = very complex)

Return ONLY this JSON structure:
{
    "scores": {
        "intentMatch": <1-10>,
        "documentation": <1-10>,
        "pricing": <1-10>,
        "reliability": <1-10>,
        "maintenance": <1-10>,
        "communityTrust": <1-10>,
        "inputComplexity": <1-10>
    },
    "strengths": ["<strength 1>", "<strength 2>"],
    "weaknesses": ["<weakness 1>", "<weakness 2>"],
    "summary": "<2 sentence summary of this Actor's fit>",
    "recommendation": "<1 sentence: should user try this? why/why not?>"
}`;

        try {
            const response = await openai.chat.completions.create({
                model: MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
            });
            
            const content = response.choices[0]?.message?.content || '{}';
            const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            
            // Calculate weighted overall score
            const scores = parsed.scores as EvaluationScores;
            const overallScore = 
                scores.intentMatch * WEIGHTS.intentMatch +
                scores.documentation * WEIGHTS.documentation +
                scores.pricing * WEIGHTS.pricing +
                scores.reliability * WEIGHTS.reliability +
                scores.maintenance * WEIGHTS.maintenance +
                scores.communityTrust * WEIGHTS.communityTrust +
                scores.inputComplexity * WEIGHTS.inputComplexity;
            
            results.push({
                rank: 0,
                actorId: actor.id,
                actorName: actor.title,
                actorUrl: actor.url,
                username: actor.username,
                scores,
                overallScore: Math.round(overallScore * 10) / 10,
                strengths: parsed.strengths || [],
                weaknesses: parsed.weaknesses || [],
                summary: parsed.summary || '',
                recommendation: parsed.recommendation || '',
            });
        } catch (error) {
            log.warning(`Evaluation failed for ${actor.title}`, { error });
        }
    }
    
    return results;
}

function formatOutput(query: string, results: EvaluationResult[], duration: string): string {
    const bar = (score: number) => '█'.repeat(score) + '░'.repeat(10 - score);
    const line = '─'.repeat(65);
    const doubleLine = '═'.repeat(65);
    
    let output = `
${doubleLine}
                      🔍 ACTOR SCOUT RESULTS
${doubleLine}

Query: "${query}"

${line}
                        🏆 TOP PICK
${line}
`;
    
    if (results.length > 0) {
        const top = results[0];
        output += `
  #1  ${top.actorName.padEnd(45)} Score: ${top.overallScore}/10
      by ${top.username} | ${top.actorUrl}
      
      ✓ Intent Match:    ${bar(top.scores.intentMatch)} ${top.scores.intentMatch}/10
      ✓ Documentation:   ${bar(top.scores.documentation)} ${top.scores.documentation}/10
      ✓ Pricing:         ${bar(top.scores.pricing)} ${top.scores.pricing}/10
      ✓ Reliability:     ${bar(top.scores.reliability)} ${top.scores.reliability}/10
      ✓ Maintenance:     ${bar(top.scores.maintenance)} ${top.scores.maintenance}/10
      
      💡 ${top.recommendation}
`;
    }
    
    output += `
${line}
                       📊 COMPARISON TABLE
${line}

  Rank  Actor                              Intent  Docs  Price  Rel.  Overall
  ────  ─────────────────────────────────  ──────  ────  ─────  ────  ───────
`;
    
    for (const r of results) {
        const name = r.actorName.length > 33 ? r.actorName.slice(0, 30) + '...' : r.actorName;
        output += `   #${r.rank}   ${name.padEnd(33)}  ${String(r.scores.intentMatch).padStart(4)}    ${String(r.scores.documentation).padStart(2)}     ${String(r.scores.pricing).padStart(2)}    ${String(r.scores.reliability).padStart(2)}     ${r.overallScore}\n`;
    }
    
    output += `
${line}
                      📝 QUICK SUMMARIES
${line}
`;
    
    for (const r of results.slice(1)) {
        output += `
  #${r.rank}  ${r.actorName.padEnd(45)} Score: ${r.overallScore}/10
      ${r.summary}
      ${r.weaknesses.length > 0 ? '⚠️  ' + r.weaknesses[0] : ''}
`;
    }
    
    output += `
${doubleLine}
  Generated by Actor Scout | Evaluated ${results.length} Actors in ${duration}s
  Model: ${MODEL}
${doubleLine}
`;
    
    return output;
}