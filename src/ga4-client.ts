/**
 * Google Analytics 4 (GA4) API Client Helper
 * Handles authentication and provides methods to interact with the GA4 Data API
 * and Admin API. Uses REST directly (compatible with Cloudflare Workers).
 *
 * Ported from contractor-scale-os's skills/ga4-analytics/scripts/ga4-analytics.js —
 * same credential family, same property-resolution logic, same API calls. That CLI
 * script remains the reference implementation; keep both in sync if either changes.
 */

interface Ga4Credentials {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}

interface SupabaseCredentials {
	url: string;
	service_role_key: string;
}

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Validate credentials format (without logging sensitive values)
 */
function validateCredentials(credentials: Ga4Credentials): void {
	if (!credentials.client_id || credentials.client_id.trim() === '') {
		throw new Error('GOOGLE_CLIENT_ID_TEAM is missing or not configured.');
	}
	if (!credentials.client_secret || credentials.client_secret.trim() === '') {
		throw new Error('GOOGLE_CLIENT_SECRET_TEAM is missing or not configured.');
	}
	if (!credentials.refresh_token || credentials.refresh_token.trim() === '') {
		throw new Error(
			'GOOGLE_MARKETING_REFRESH_TOKEN is missing or not configured. ' +
				'Do not substitute GOOGLE_REFRESH_TOKEN or GOOGLE_TEAM_REFRESH_TOKEN — neither carries the analytics.readonly scope.'
		);
	}
}

/**
 * Get OAuth2 access token using the marketing refresh token. Minted fresh per call,
 * same as google-ads-mcp-cs — call volume through this Worker is low enough that
 * token caching isn't worth the added state.
 */
async function getAccessToken(credentials: Ga4Credentials): Promise<string> {
	validateCredentials(credentials);

	const response = await fetch(OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: credentials.client_id,
			client_secret: credentials.client_secret,
			refresh_token: credentials.refresh_token,
			grant_type: 'refresh_token',
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Failed to refresh GA4 access token: ${errorText}`);
	}

	const data = (await response.json()) as { access_token: string };
	return data.access_token;
}

async function apiCall(credentials: Ga4Credentials, url: string, options: { method?: string; body?: string } = {}): Promise<any> {
	const accessToken = await getAccessToken(credentials);
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';

	const res = await fetch(url, { method: options.method || 'GET', headers, body: options.body });
	const text = await res.text();

	if (!res.ok) {
		let detail = text;
		try {
			detail = JSON.parse(text)?.error?.message || text;
		} catch {
			/* keep raw text */
		}
		if (res.status === 403) {
			if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail)) {
				throw new Error(
					`GA4 API 403 (scope): ${detail}\n` +
						'GOOGLE_MARKETING_REFRESH_TOKEN does not carry analytics.readonly — re-mint it with the ' +
						'flow that requests all three marketing scopes together (see ga4-analytics/SKILL.md).'
				);
			}
			throw new Error(
				`GA4 API 403 (access): ${detail}\nteam@contractorscale.com likely lacks access to this property. ` +
					'Grant it Viewer/Analyst in GA4 Admin → Property Access Management.'
			);
		}
		throw new Error(`GA4 API request failed (${res.status} ${res.statusText}): ${detail}`);
	}

	return text ? JSON.parse(text) : {};
}

// --- property resolution (mirrors ga4-analytics.js resolveProperty) ---------

function cleanDomain(input: string): string {
	return String(input)
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/^www\./i, '')
		.replace(/\/.*$/, '')
		.replace(/:\d+$/, '')
		.toLowerCase();
}

interface MasterClientRow {
	client_name: string;
	website: string | null;
	ga_property_id: string | null;
}

async function sbSelectMasterClients(supabase: SupabaseCredentials): Promise<MasterClientRow[]> {
	const params = new URLSearchParams({ select: 'client_name,website,ga_property_id' });
	const res = await fetch(`${supabase.url.replace(/\/+$/, '')}/rest/v1/master_clients?${params.toString()}`, {
		headers: {
			apikey: supabase.service_role_key,
			Authorization: `Bearer ${supabase.service_role_key}`,
			Accept: 'application/json',
		},
	});
	if (!res.ok) throw new Error(`Supabase master_clients read failed: ${res.status} ${await res.text()}`);
	return res.json();
}

export interface ResolvedProperty {
	propertyId: string;
	client?: string;
	source: string;
}

export interface PropertySelector {
	property?: string;
	url?: string;
	domain?: string;
	clientSlug?: string;
}

export async function resolveProperty(selector: PropertySelector, supabase: SupabaseCredentials): Promise<ResolvedProperty> {
	if (selector.property) {
		return { propertyId: selector.property.replace(/^properties\//, ''), source: '--property' };
	}

	const rows = await sbSelectMasterClients(supabase);

	let match: MasterClientRow | undefined;
	let usedSelector: string;

	if (selector.clientSlug) {
		usedSelector = `--client-slug ${selector.clientSlug}`;
		const want = selector.clientSlug.toLowerCase().replace(/[\s_-]+/g, '');
		match = rows.find((r) => r.client_name && r.client_name.toLowerCase().replace(/[\s_-]+/g, '') === want);
	} else if (selector.url || selector.domain) {
		const raw = selector.url || (selector.domain as string);
		usedSelector = `--${selector.url ? 'url' : 'domain'} ${raw}`;
		const want = cleanDomain(raw);
		match = rows.find((r) => r.website && cleanDomain(r.website) === want);
	} else {
		throw new Error('Provide one of url, domain, clientSlug, or property.');
	}

	if (!match) {
		throw new Error(
			`No master_clients row matched ${usedSelector}. Call list_properties to see what the team ` +
				"account can access, and check the client's website column in master_clients."
		);
	}

	if (!match.ga_property_id) {
		throw new Error(
			`Client '${match.client_name}' matched ${usedSelector}, but master_clients.ga_property_id is empty. ` +
				'This is a data gap — backfill the column rather than guessing a property ID.'
		);
	}

	return {
		propertyId: match.ga_property_id.replace(/^properties\//, ''),
		client: match.client_name,
		source: usedSelector,
	};
}

// --- GA4 operations -----------------------------------------------------------

export async function listProperties(credentials: Ga4Credentials): Promise<any> {
	const out: any[] = [];
	let pageToken: string | undefined;
	do {
		const url = new URL(`${ADMIN_API}/accountSummaries`);
		url.searchParams.set('pageSize', '200');
		if (pageToken) url.searchParams.set('pageToken', pageToken);
		const page = await apiCall(credentials, url.toString());
		out.push(...(page.accountSummaries || []));
		pageToken = page.nextPageToken;
	} while (pageToken);
	return { accountSummaries: out };
}

export async function getMetadata(credentials: Ga4Credentials, propertyId: string): Promise<any> {
	return apiCall(credentials, `${DATA_API}/properties/${propertyId}/metadata`);
}

export async function runReport(credentials: Ga4Credentials, propertyId: string, body: string): Promise<any> {
	return apiCall(credentials, `${DATA_API}/properties/${propertyId}:runReport`, { method: 'POST', body });
}

export async function batchRunReports(credentials: Ga4Credentials, propertyId: string, body: string): Promise<any> {
	return apiCall(credentials, `${DATA_API}/properties/${propertyId}:batchRunReports`, { method: 'POST', body });
}

export async function smokeTest(credentials: Ga4Credentials, resolved: ResolvedProperty): Promise<any> {
	const body = JSON.stringify({
		dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
		dimensions: [{ name: 'sessionDefaultChannelGroup' }],
		metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
		limit: '10',
	});
	const report = await runReport(credentials, resolved.propertyId, body);
	const totalRows = report.rowCount || 0;
	const sessions = (report.rows || []).reduce((sum: number, r: any) => sum + Number(r.metricValues?.[0]?.value || 0), 0);
	return {
		ok: true,
		client: resolved.client || null,
		property: resolved.propertyId,
		resolvedVia: resolved.source,
		window: 'last 28 days',
		channelRows: totalRows,
		sessions,
		note:
			sessions === 0
				? 'Zero sessions over 28 days — check the data stream / tagging before reporting a decline.'
				: 'Auth, property resolution, and Data API access all working.',
	};
}

export type { Ga4Credentials, SupabaseCredentials };
