import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { Actor, log } from 'apify';
import { ApifyClient } from 'apify-client';
import { CheerioCrawler } from 'crawlee';
import OpenAI from 'openai';

const MAX_ATTEMPTS = 5;

interface Input {
    query: string;
    maxActors?: number;
}

interface AttemptRecord {
    attempt: number;
    input: object;
    error?: string;
}

interface ComparisonResult {
    actorId: string;
    actorName: string;
    actorTitle: string;
    actorDescription: string;
    inputSchema: object;
    attempts: number;
    attemptHistory: AttemptRecord[];
    finalInput?: object;
    runId?: string;
    runStatus?: string;
    runDurationSecs?: number;
    output?: object[];
    success: boolean;
    // Evaluation scores from Actor Scout
    scores?: EvaluationScores;
    overallScore?: number;
    strengths?: string[];
    weaknesses?: string[];
    recommendation?: string;
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
    readme?: string;
    pricing?: string;
}

interface EvaluationScores {
    intentMatch: number;
    documentation: number;
    pricing: number;
    reliability: number;
    maintenance: number;
    communityTrust: number;
    inputComplexity: number;
}

// ============ CONSTANTS ============
const EVAL_MODEL = 'google/gemini-2.5-flash';
const WEIGHTS = {
    intentMatch: 0.30,
    documentation: 0.15,
    pricing: 0.15,
    reliability: 0.20,
    maintenance: 0.10,
    communityTrust: 0.05,
    inputComplexity: 0.05,
};

// Build prompt with optional error feedback
function buildPrompt(
    actor: { title?: string; name: string; description?: string },
    schema: object,
    query: string,
    previousError: string | null,
    attempt: number
): string {
    let prompt = `Generate valid input JSON for this Apify actor.

Actor: ${actor.title || actor.name}
Description: ${actor.description || 'No description'}

Input Schema:
${JSON.stringify(schema, null, 2)}

Requirements:
- Output ONLY valid JSON, no markdown, no explanation
- Match the schema exactly
- Use realistic, working values
- For URLs, use real accessible websites related to "${query}"
- Keep arrays small (1-2 items) to minimize run time
- Use sensible defaults for optional fields`;

    if (previousError) {
        prompt += `

⚠️ PREVIOUS ATTEMPT ${attempt - 1}/${MAX_ATTEMPTS} FAILED:
Error: ${previousError}

Please fix the input to address this error.`;
    }

    return prompt + '\n\nJSON:';
}

// ============ ACTOR SCOUT HELPERS ============

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
        model: EVAL_MODEL,
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

    return data.data.items
        .filter((item: any) => item.currentPricingInfo?.pricingModel !== 'FLAT_PRICE_PER_MONTH')
        .map((item: any) => ({
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

            const pricingText = $('body').text();
            const pricingMatch = pricingText.match(/\$[\d.]+\s*(per|\/)\s*\d*\s*(result|run|item|request|1[,\d]*)/i);
            const pricing = pricingMatch ? pricingMatch[0] : 'See pricing tab';

            details.set(actorId, {
                readme: readme.slice(0, 4000),
                pricing,
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

interface EvaluationResult {
    actorId: string;
    username: string;
    name: string;
    title: string;
    description: string;
    url: string;
    scores: EvaluationScores;
    overallScore: number;
    strengths: string[];
    weaknesses: string[];
    recommendation: string;
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
    "recommendation": "<1 sentence: should user try this? why/why not?>"
}`;

        try {
            const response = await openai.chat.completions.create({
                model: EVAL_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
            });

            const content = response.choices[0]?.message?.content || '{}';
            const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleaned);

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
                actorId: `${actor.username}/${actor.name}`,
                username: actor.username,
                name: actor.name,
                title: actor.title,
                description: actor.description,
                url: actor.url,
                scores,
                overallScore: Math.round(overallScore * 10) / 10,
                strengths: parsed.strengths || [],
                weaknesses: parsed.weaknesses || [],
                recommendation: parsed.recommendation || '',
            });
        } catch (error) {
            log.warning(`Evaluation failed for ${actor.title}`, { error });
        }
    }

    return results;
}

// ============ MAIN ============

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.query) {
    throw new Error('Missing required input: query');
}

const apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
    throw new Error('Missing APIFY_TOKEN');
}

const maxActors = input.maxActors ?? 3;
const { query } = input;

log.info('Starting Actor Scout + Runner', { query, maxActors });

const client = new ApifyClient({
    token: apifyToken,
});

// Use Apify's OpenRouter proxy for input generation
const openrouter = createOpenAI({
    baseURL: 'https://openrouter.apify.actor/api/v1',
    apiKey: 'not-needed',
    headers: {
        Authorization: `Bearer ${apifyToken}`,
    },
});

// Step 1: Extract search terms from query
log.info('Step 1: Analyzing query...');
const searchTerms = await extractSearchTerms(query);
log.info('Search terms extracted', { searchTerms });

// Step 2: Search Apify Store (get more candidates for evaluation)
log.info('Step 2: Searching Apify Store...');
const candidates = await searchApifyStore(searchTerms, maxActors * 3);
log.info(`Found ${candidates.length} candidates`);

// Step 3: Fetch detailed info (README, pricing)
log.info('Step 3: Fetching Actor details...');
const detailedCandidates = await fetchActorDetails(candidates.slice(0, maxActors * 2));

// Step 4: Evaluate each Actor with LLM
log.info('Step 4: Evaluating Actors...');
const evaluations = await evaluateActors(detailedCandidates, query);

// Step 5: Rank and select top N
const ranked = evaluations
    .sort((a, b) => b.overallScore - a.overallScore)
    .slice(0, maxActors);

log.info(`Top ${ranked.length} actors by score:`, {
    actors: ranked.map((r, i) => `${i + 1}. ${r.title} (${r.overallScore}/10)`)
});

// Convert ranked evaluations to format needed for processActor
const actorsToRun = ranked.map(r => ({
    username: r.username,
    name: r.name,
    title: r.title,
    description: r.description,
    // Include evaluation data for output
    _evaluation: r,
}));

// Step 6: Process a single actor (run with generated input)
async function processActor(storeActor: any): Promise<ComparisonResult> {
    const actorId = `${storeActor.username}/${storeActor.name}`;
    log.info(`[${actorId}] Running actor...`);

    const evaluation = storeActor._evaluation as EvaluationResult | undefined;

    const result: ComparisonResult = {
        actorId,
        actorName: storeActor.name,
        actorTitle: storeActor.title || storeActor.name,
        actorDescription: storeActor.description || '',
        inputSchema: {},
        attempts: 0,
        attemptHistory: [],
        success: false,
        // Include evaluation scores
        scores: evaluation?.scores,
        overallScore: evaluation?.overallScore,
        strengths: evaluation?.strengths,
        weaknesses: evaluation?.weaknesses,
        recommendation: evaluation?.recommendation,
    };

    try {
        // Get input schema
        const buildClient = await client.actor(actorId).defaultBuild();
        const build = await buildClient.get();
        const inputSchema = build?.actorDefinition?.input;

        if (!inputSchema) {
            console.log(`[${actorId}] Skipping: no input schema`);
            result.attemptHistory.push({ attempt: 0, input: {}, error: 'No input schema found' });
            return result;
        }

        result.inputSchema = inputSchema;

        // Iterative agent loop
        let attempt = 0;
        let lastError: string | null = null;

        while (attempt < MAX_ATTEMPTS && !result.success) {
            attempt++;
            result.attempts = attempt;
            console.log(`[${actorId}] Attempt ${attempt}/${MAX_ATTEMPTS}...`);

            // Generate input
            const prompt = buildPrompt(storeActor, inputSchema, query, lastError, attempt);
            const { text } = await generateText({
                model: openrouter('google/gemma-3-27b-it:free'),
                prompt,
            });

            // Parse JSON
            let generatedInput: object;
            try {
                const cleaned = text.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
                generatedInput = JSON.parse(cleaned);
            } catch (e) {
                lastError = `Failed to parse LLM response as JSON: ${text.substring(0, 200)}`;
                result.attemptHistory.push({ attempt, input: {}, error: lastError });
                console.log(`[${actorId}] Parse error, retrying...`);
                continue;
            }

            // Try running the actor
            try {
                const run = await client.actor(actorId).call(generatedInput, {
                    timeout: 120,
                    memory: 1024,
                    waitSecs: 120,
                });

                if (run.status === 'SUCCEEDED') {
                    result.success = true;
                    result.finalInput = generatedInput;
                    result.runId = run.id;
                    result.runStatus = run.status;
                    result.runDurationSecs = run.stats?.durationMillis ? run.stats.durationMillis / 1000 : undefined;

                    // Get output
                    if (run.defaultDatasetId) {
                        const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: 5 });
                        result.output = dataset.items;
                    }

                    result.attemptHistory.push({ attempt, input: generatedInput });
                    console.log(`[${actorId}] ✓ Success! (${result.runDurationSecs?.toFixed(1)}s)`);
                } else {
                    lastError = `Run completed with status: ${run.status}`;
                    result.attemptHistory.push({ attempt, input: generatedInput, error: lastError });
                    // Don't retry on timeout - it won't get faster
                    if (run.status === 'TIMED-OUT') {
                        console.log(`[${actorId}] Timed out, skipping retries`);
                        break;
                    }
                    console.log(`[${actorId}] Status: ${run.status}, retrying...`);
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                result.attemptHistory.push({ attempt, input: generatedInput, error: lastError });
                console.log(`[${actorId}] Error: ${lastError.substring(0, 60)}...`);
            }
        }

        if (!result.success) {
            console.log(`[${actorId}] ✗ Failed after ${attempt} attempts`);
        }

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`[${actorId}] Fatal error: ${errorMsg}`);
        result.attemptHistory.push({ attempt: 0, input: {}, error: errorMsg });
    }

    return result;
}

// Step 7: Run top actors in parallel
log.info(`Step 7: Running ${actorsToRun.length} top-scored actors in parallel...`);
const settled = await Promise.allSettled(actorsToRun.map(processActor));

const comparisonResults: ComparisonResult[] = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
        return result.value;
    }
    // Handle rejected promises
    const actor = actorsToRun[i];
    const evaluation = actor._evaluation as EvaluationResult;
    return {
        actorId: `${actor.username}/${actor.name}`,
        actorName: actor.name,
        actorTitle: actor.title,
        actorDescription: actor.description,
        inputSchema: {},
        attempts: 0,
        attemptHistory: [{ attempt: 0, input: {}, error: result.reason?.message || String(result.reason) }],
        success: false,
        scores: evaluation?.scores,
        overallScore: evaluation?.overallScore,
        strengths: evaluation?.strengths,
        weaknesses: evaluation?.weaknesses,
        recommendation: evaluation?.recommendation,
    };
});

const successCount = comparisonResults.filter(r => r.success).length;
log.info(`Completed: ${successCount}/${comparisonResults.length} succeeded`);

// Sort results by overall score for output
const sortedResults = comparisonResults.sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0));

await Actor.pushData(sortedResults);
await Actor.exit();
