/**
 * @module tools
 *
 * `createTool` — the elegant way to define tools for your agent.
 *
 * @example
 * ```ts
 * import { createTool } from '@yesvara/svara';
 *
 * const weatherTool = createTool({
 *   name: 'get_weather',
 *   description: 'Get the current weather for a location',
 *   parameters: {
 *     city: { type: 'string', description: 'City name', required: true },
 *     units: { type: 'string', description: 'Temperature units', enum: ['celsius', 'fahrenheit'] },
 *   },
 *   async run({ city, units = 'celsius' }) {
 *     const data = await fetchWeather(city as string);
 *     return { temp: data.temp, condition: data.description, city };
 *   },
 * });
 *
 * agent.addTool(weatherTool);
 * ```
 */

import type { Tool } from '../types.js';

/**
 * Create a type-safe tool definition with IDE autocomplete.
 *
 * This is a convenience wrapper — it validates your tool at definition time
 * and returns a properly typed `Tool` object.
 *
 * @example Basic tool
 * ```ts
 * const timeTool = createTool({
 *   name: 'get_current_time',
 *   description: 'Get the current date and time',
 *   parameters: {},
 *   async run() {
 *     return { datetime: new Date().toISOString() };
 *   },
 * });
 * ```
 *
 * @example Tool with parameters and error handling
 * ```ts
 * const searchTool = createTool({
 *   name: 'search_database',
 *   description: 'Search for records in the database',
 *   parameters: {
 *     query: { type: 'string', description: 'Search query', required: true },
 *     limit: { type: 'number', description: 'Max results to return' },
 *   },
 *   async run({ query, limit = 10 }, ctx) {
 *     console.log(`[${ctx.agentName}] Searching for: ${query}`);
 *     const results = await db.search(String(query), Number(limit));
 *     return { results, count: results.length };
 *   },
 *   timeout: 10_000, // 10 seconds
 * });
 * ```
 */
export function createTool(definition: Tool): Tool {
  // Validate at definition time — fail fast, not at runtime
  if (!definition.name?.trim()) {
    throw new Error('[@yesvara/svara] createTool: "name" is required.');
  }
  if (!definition.description?.trim()) {
    throw new Error(`[@yesvara/svara] createTool "${definition.name}": "description" is required.`);
  }
  if (typeof definition.run !== 'function') {
    throw new Error(`[@yesvara/svara] createTool "${definition.name}": "run" must be a function.`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(definition.name)) {
    throw new Error(
      `[@yesvara/svara] createTool: Invalid tool name "${definition.name}". ` +
      'Use only letters, numbers, underscores, or hyphens.'
    );
  }

  return {
    parameters: {},
    ...definition,
  };
}

export type { Tool } from '../types.js';
