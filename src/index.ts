/**
 * ============================================================================
 * CUSTOMIZATION SECTION - Update these values for your MCP server
 * ============================================================================
 */

import {
	resolveProperty,
	listProperties,
	getMetadata,
	runReport,
	batchRunReports,
	smokeTest,
	type Ga4Credentials,
	type SupabaseCredentials,
	type PropertySelector,
} from './ga4-client';

interface Env {
	GOOGLE_CLIENT_ID_TEAM: string;
	GOOGLE_CLIENT_SECRET_TEAM: string;
	GOOGLE_MARKETING_REFRESH_TOKEN: string;
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	API_KEY?: string;
}

const CONFIG = {
	serverName: 'ga4-mcp',
	serverVersion: '1.0.0',
	serverDescription: 'Google Analytics 4 (GA4) MCP Server',
	protocolVersion: '2025-03-26', // previously '2024-11-05'
	keepAliveInterval: 30000, // 30 seconds
} as const;

/**
 * ============================================================================
 * TOOL DEFINITIONS - Add your custom tools here
 * ============================================================================
 * Each tool should have:
 * - name: unique identifier for the tool
 * - description: what the tool does
 * - inputSchema: JSON schema defining the input parameters
 * - handler: function that executes the tool logic
 */

interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: string;
		properties: Record<string, any>;
		required: string[];
	};
	handler: (args: Record<string, unknown>, env: Env) => Promise<ToolResult> | ToolResult;
}

interface ToolResult {
	content: Array<{
		type: string;
		text: string;
	}>;
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function getCredentials(env: Env): Ga4Credentials {
	return {
		client_id: env.GOOGLE_CLIENT_ID_TEAM,
		client_secret: env.GOOGLE_CLIENT_SECRET_TEAM,
		refresh_token: env.GOOGLE_MARKETING_REFRESH_TOKEN,
	};
}

function missingCredentials(creds: Ga4Credentials): string[] {
	const missing: string[] = [];
	if (!creds.client_id) missing.push('GOOGLE_CLIENT_ID_TEAM');
	if (!creds.client_secret) missing.push('GOOGLE_CLIENT_SECRET_TEAM');
	if (!creds.refresh_token) missing.push('GOOGLE_MARKETING_REFRESH_TOKEN');
	return missing;
}

function getSupabaseCredentials(env: Env): SupabaseCredentials {
	return { url: env.SUPABASE_URL, service_role_key: env.SUPABASE_SERVICE_ROLE_KEY };
}

function missingSupabase(supabase: SupabaseCredentials): string[] {
	const missing: string[] = [];
	if (!supabase.url) missing.push('SUPABASE_URL');
	if (!supabase.service_role_key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
	return missing;
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify({ error: true, message }, null, 2) }] };
}

function successResult(data: any): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function selectorFromArgs(args: Record<string, unknown>): PropertySelector {
	return {
		property: typeof args.property === 'string' ? args.property : undefined,
		url: typeof args.url === 'string' ? args.url : undefined,
		domain: typeof args.domain === 'string' ? args.domain : undefined,
		clientSlug: typeof args.clientSlug === 'string' ? args.clientSlug : undefined,
	};
}

const SELECTOR_PROPERTIES = {
	property: { type: 'string', description: 'Explicit GA4 property ID (e.g. "358301924"). Skips Supabase resolution entirely.' },
	url: { type: 'string', description: 'Client website URL — resolved against master_clients.website (preferred for multi-client work).' },
	domain: { type: 'string', description: 'Already-cleaned client domain — alternative to url.' },
	clientSlug: { type: 'string', description: 'Client name — matched against master_clients.client_name.' },
};

async function resolveOrError(
	args: Record<string, unknown>,
	env: Env
): Promise<{ resolved: Awaited<ReturnType<typeof resolveProperty>> } | { error: ToolResult }> {
	const supabase = getSupabaseCredentials(env);
	const missingSb = missingSupabase(supabase);
	if (missingSb.length > 0) return { error: errorResult(`Missing required credentials: ${missingSb.join(', ')}`) };

	try {
		const resolved = await resolveProperty(selectorFromArgs(args), supabase);
		return { resolved };
	} catch (e) {
		return { error: errorResult(e instanceof Error ? e.message : String(e)) };
	}
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
	{
		name: 'list_properties',
		description:
			'Lists every GA4 account and property visible to the authenticated team principal (team@contractorscale.com). ' +
			'Use this first to find a property ID when url/domain/clientSlug resolution fails, or to audit GA4 access.',
		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
		},
		handler: async (_args, env): Promise<ToolResult> => {
			const creds = getCredentials(env);
			const missing = missingCredentials(creds);
			if (missing.length > 0) return errorResult(`Missing required credentials: ${missing.join(', ')}`);
			try {
				return successResult(await listProperties(creds));
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	},

	{
		name: 'get_metadata',
		description:
			'Returns the valid dimensions and metrics for a GA4 property. Run this before run_report if you need a dimension ' +
			'or metric not already known — custom events and conversions vary per client. ' +
			'Resolve the property with exactly one of: url, domain, clientSlug, property.',
		inputSchema: {
			type: 'object',
			properties: { ...SELECTOR_PROPERTIES },
			required: [],
		},
		handler: async (args, env): Promise<ToolResult> => {
			const creds = getCredentials(env);
			const missing = missingCredentials(creds);
			if (missing.length > 0) return errorResult(`Missing required credentials: ${missing.join(', ')}`);

			const resolution = await resolveOrError(args, env);
			if ('error' in resolution) return resolution.error;

			try {
				return successResult(await getMetadata(creds, resolution.resolved.propertyId));
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	},

	{
		name: 'run_report',
		description:
			'Runs a single GA4 Data API report (traffic, channels, conversions, landing pages, etc). ' +
			'`report` is the raw GA4 runReport request body — dateRanges, dimensions, metrics, orderBys, limit, dimensionFilter — ' +
			'passed through verbatim to the Data API. Resolve the property with exactly one of: url, domain, clientSlug, property. ' +
			'Example report: {"dateRanges":[{"startDate":"90daysAgo","endDate":"today"}],"dimensions":[{"name":"sessionDefaultChannelGroup"}],' +
			'"metrics":[{"name":"sessions"},{"name":"totalUsers"},{"name":"keyEvents"}]} ' +
			'Note: the GA4 "conversions" metric was renamed "keyEvents" — use keyEvents, not conversions.',
		inputSchema: {
			type: 'object',
			properties: {
				...SELECTOR_PROPERTIES,
				report: { type: 'object', description: 'GA4 Data API runReport request body (dateRanges, dimensions, metrics, etc).' },
			},
			required: ['report'],
		},
		handler: async (args, env): Promise<ToolResult> => {
			const creds = getCredentials(env);
			const missing = missingCredentials(creds);
			if (missing.length > 0) return errorResult(`Missing required credentials: ${missing.join(', ')}`);
			if (!args.report || typeof args.report !== 'object') return errorResult('report (object) is required');

			const resolution = await resolveOrError(args, env);
			if ('error' in resolution) return resolution.error;

			try {
				const result = await runReport(creds, resolution.resolved.propertyId, JSON.stringify(args.report));
				return successResult(result);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	},

	{
		name: 'batch_run_reports',
		description:
			'Runs several GA4 Data API reports against one property in a single call. ' +
			'`requests` is an array of report bodies, each shaped like run_report\'s `report` parameter. ' +
			'Resolve the property with exactly one of: url, domain, clientSlug, property.',
		inputSchema: {
			type: 'object',
			properties: {
				...SELECTOR_PROPERTIES,
				requests: {
					type: 'array',
					items: { type: 'object' },
					description: 'Array of GA4 Data API runReport request bodies.',
				},
			},
			required: ['requests'],
		},
		handler: async (args, env): Promise<ToolResult> => {
			const creds = getCredentials(env);
			const missing = missingCredentials(creds);
			if (missing.length > 0) return errorResult(`Missing required credentials: ${missing.join(', ')}`);
			if (!Array.isArray(args.requests)) return errorResult('requests (array) is required');

			const resolution = await resolveOrError(args, env);
			if ('error' in resolution) return resolution.error;

			try {
				const body = JSON.stringify({ requests: args.requests });
				const result = await batchRunReports(creds, resolution.resolved.propertyId, body);
				return successResult(result);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	},

	{
		name: 'smoke_test',
		description:
			'Confirms auth, property resolution, and Data API access all work for one client property by running a bounded ' +
			'28-day channel/session report. Use this to verify a new property or diagnose a reported GA4 failure before ' +
			'trusting a bigger report. Resolve the property with exactly one of: url, domain, clientSlug, property.',
		inputSchema: {
			type: 'object',
			properties: { ...SELECTOR_PROPERTIES },
			required: [],
		},
		handler: async (args, env): Promise<ToolResult> => {
			const creds = getCredentials(env);
			const missing = missingCredentials(creds);
			if (missing.length > 0) return errorResult(`Missing required credentials: ${missing.join(', ')}`);

			const resolution = await resolveOrError(args, env);
			if ('error' in resolution) return resolution.error;

			try {
				return successResult(await smokeTest(creds, resolution.resolved));
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	},
];

/**
 * ============================================================================
 * FRAMEWORK CODE - You typically don't need to modify below this line
 * ============================================================================
 */

// Session interface for SSE connections
interface Session {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	encoder: TextEncoder;
}

// Store active sessions
const sessions = new Map<string, Session>();

/**
 * Validate API key from request headers
 * Supports both X-API-Key header and Authorization Bearer token
 * Returns null if valid, error message string if invalid
 */
function validateApiKey(request: Request, env: Env): string | null {
	// Skip validation if API key is not configured
	if (!env.API_KEY || env.API_KEY.trim() === '') {
		return null;
	}

	const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '').trim();

	if (!apiKey) {
		return 'API key is required. Please provide X-API-Key header or Authorization Bearer token.';
	}

	if (apiKey !== env.API_KEY) {
		return 'Invalid API key.';
	}

	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS headers - modify if you need to restrict origins
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*', // Change to specific domain if needed
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Accept, X-API-Key, Authorization',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// Health check endpoint (no API key required)
		if (url.pathname === '/' || url.pathname === '') {
			const healthResponse = {
				name: CONFIG.serverDescription,
				version: CONFIG.serverVersion,
				status: 'running',
				endpoints: {
					sse: '/sse',
					mcp: '/mcp',
				},
			};
			return new Response(JSON.stringify(healthResponse), {
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}

		// Validate API key for protected endpoints (exclude health check)
		const apiKeyError = validateApiKey(request, env);
		if (apiKeyError) {
			return new Response(
				JSON.stringify({
					error: 'Unauthorized',
					message: apiKeyError,
				}),
				{
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						...corsHeaders,
					},
				}
			);
		}

		// SSE endpoint - GET only
		if (url.pathname === '/sse' && request.method === 'GET') {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			const sessionId = crypto.randomUUID().replace(/-/g, '');
			sessions.set(sessionId, { writer, encoder });

			(async () => {
				try {
					await writer.write(encoder.encode(`event: endpoint\ndata: /sse/message?sessionId=${sessionId}\n\n`));

					const keepAlive = setInterval(async () => {
						try {
							await writer.write(encoder.encode(': ping\n\n'));
						} catch {
							clearInterval(keepAlive);
							sessions.delete(sessionId);
						}
					}, CONFIG.keepAliveInterval);
				} catch {
					sessions.delete(sessionId);
				}
			})();

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					...corsHeaders,
				},
			});
		}

		// Handle POST to /sse (some clients do this for direct HTTP)
		if (url.pathname === '/sse' && request.method === 'POST') {
			return handleMessage(request, corsHeaders, null, env, 'POST /sse');
		}

		// Messages endpoint with session
		if (url.pathname === '/sse/message' && request.method === 'POST') {
			const sessionId = url.searchParams.get('sessionId');
			const session = sessions.get(sessionId || '') ?? null;
			return handleMessage(request, corsHeaders, session, env, 'POST /sse/message');
		}

		// MCP HTTP endpoint - POST only (streamable HTTP transport)
		if (url.pathname === '/mcp' && request.method === 'POST') {
			return handleMessage(request, corsHeaders, null, env, 'POST /mcp');
		}

		return new Response('Not Found', {
			status: 404,
			headers: corsHeaders,
		});
	},
};

// Centralized message handler
async function handleMessage(
	request: Request,
	corsHeaders: Record<string, string>,
	session: Session | null,
	env: Env,
	endpoint = 'unknown'
) {
	try {
		const body = await request.text();

		let message;
		try {
			message = JSON.parse(body);
		} catch {
			const errorResponse = {
				jsonrpc: '2.0',
				error: { code: -32700, message: 'Parse error' },
			};
			return new Response(JSON.stringify(errorResponse), {
				status: 400,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}

		let response: Record<string, unknown> | null = null;

		if (message.method === 'initialize') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: CONFIG.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: CONFIG.serverName, version: CONFIG.serverVersion },
				},
			};
		} else if (message.method === 'tools/list') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					tools: TOOLS.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				},
			};
		} else if (message.method === 'tools/call') {
			const { name, arguments: args } = message.params;
			const tool = TOOLS.find((t) => t.name === name);

			if (tool) {
				try {
					const result = await tool.handler(args, env);
					if (!result || !result.content || !Array.isArray(result.content)) {
						throw new Error(`Tool handler returned invalid result structure. Expected content array, got: ${JSON.stringify(result)}`);
					}
					response = { jsonrpc: '2.0', id: message.id, result };
				} catch (toolError: unknown) {
					response = {
						jsonrpc: '2.0',
						id: message.id,
						error: { code: -32603, message: toolError instanceof Error ? toolError.message : 'Tool execution failed' },
					};
				}
			} else {
				response = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown tool: ${name}` } };
			}
		} else if (message.method === 'notifications/initialized') {
			return new Response(null, { status: 204, headers: corsHeaders });
		} else {
			response = {
				jsonrpc: '2.0',
				id: message.id || null,
				error: { code: -32601, message: `Method not found: ${message.method}` },
			};
		}

		const responseBody = JSON.stringify(response);

		if (session && response) {
			try {
				await session.writer.write(session.encoder.encode(`data: ${responseBody}\n\n`));
			} catch {
				/* best-effort SSE write */
			}
		}

		if (response) {
			return new Response(responseBody, {
				status: 200,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}

		return new Response(null, { status: 204, headers: corsHeaders });
	} catch (error: unknown) {
		const errorResponse = {
			jsonrpc: '2.0',
			error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
		};
		return new Response(JSON.stringify(errorResponse), {
			status: 500,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}
}
