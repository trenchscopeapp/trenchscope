import { readFileSync } from 'node:fs';

export const APP_URI = 'ui://trenchscope/market.html';
export const APP_MIME = 'text/html;profile=mcp-app';
const APP_TOOLS = new Set(['screener_query', 'get_token', 'get_dossier']);

export function withApp<T extends { name: string }>(tool: T) {
  return { ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    ...(APP_TOOLS.has(tool.name) ? { _meta: { ui: { resourceUri: APP_URI, visibility: ['model', 'app'] } } } : {}) };
}

export function appResource() {
  return { contents: [{ uri: APP_URI, mimeType: APP_MIME,
    text: readFileSync(new URL('./ui/market.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] };
}
