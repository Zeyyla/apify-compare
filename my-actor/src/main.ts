import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { Actor } from 'apify';
import { ApifyClient } from 'apify-client';

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
}

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
console.log(`Searching Apify Store for: "${input.query}" (max ${maxActors} actors)`);

const client = new ApifyClient({
    token: apifyToken,
});

// Use Apify's OpenRouter proxy
const openrouter = createOpenAI({
    baseURL: 'https://openrouter.apify.actor/api/v1',
    apiKey: 'not-needed',
    headers: {
        Authorization: `Bearer ${apifyToken}`,
    },
});

// Step 1: Search store
const allResults = await client.store().list({
    search: input.query,
    limit: 50,
    sortBy: 'relevance',
});

// Filter out FLAT_PRICE_PER_MONTH actors
const actors = allResults.items
    .filter((a: any) => a.currentPricingInfo?.pricingModel !== 'FLAT_PRICE_PER_MONTH')
    .slice(0, maxActors);

console.log(`Found ${allResults.items.length} actors, ${actors.length} after filtering\n`);

// Process a single actor
async function processActor(storeActor: any): Promise<ComparisonResult> {
    const actorId = `${storeActor.username}/${storeActor.name}`;
    console.log(`[${actorId}] Starting...`);

    const result: ComparisonResult = {
        actorId,
        actorName: storeActor.name,
        actorTitle: storeActor.title || storeActor.name,
        actorDescription: storeActor.description || '',
        inputSchema: {},
        attempts: 0,
        attemptHistory: [],
        success: false,
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
            const prompt = buildPrompt(storeActor, inputSchema, input.query, lastError, attempt);
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

// Step 2: Run all actors in parallel
console.log(`Running ${actors.length} actors in parallel...\n`);
const comparisonResults = await Promise.all(actors.map(processActor));

const successCount = comparisonResults.filter(r => r.success).length;
console.log(`\nCompleted: ${successCount}/${comparisonResults.length} succeeded`);

await Actor.pushData(comparisonResults);
await Actor.exit();
