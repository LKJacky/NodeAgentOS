// Rebuild a provider row as the protocol it names.
import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import { type Fetcher, type JsonObject, OpenAIProvider, type Provider } from './base.js';
import { ResponsesProvider } from './responses.js';

/** Rebuild a provider row as the protocol it names.
 *
 *  `name` is the row that holds it: a request that cannot reach its endpoint names the row and the
 *  host rather than the SDK's own "Connection error."
 */
export function buildProvider(data: JsonObject, fetcher: Fetcher, name = ''): Provider {
  const provider = buildWire(data, fetcher);
  provider.name = name;
  return provider;
}

function buildWire(data: JsonObject, fetcher: Fetcher): Provider {
  const type = data.type;
  if (type === 'openai') return OpenAIProvider.build(data, fetcher);
  if (type === 'anthropic') return AnthropicProvider.build(data, fetcher);
  if (type === 'deepseek') return DeepSeekProvider.build(data, fetcher);
  if (type === 'responses') return ResponsesProvider.build(data, fetcher);
  throw new Error(`unknown provider type: ${JSON.stringify(type)}`);
}

export { AnthropicProvider, DeepSeekProvider, OpenAIProvider, ResponsesProvider };
export type { Fetcher, JsonObject, Provider };
export * from './base.js';
