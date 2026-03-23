/**
 * xAI Responses API — mars 2026 : `search_parameters` (live search) renvoie **410 Gone**.
 * Remplacé par l’outil officiel **`web_search`** (doc : guides/live-search, tools/overview).
 */
export const XAI_RESPONSES_WEB_TOOLS = [{ type: 'web_search' as const }];
