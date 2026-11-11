# node-agent-search

A node-agent bus node — its name on the bus is `search` — exposing `search.search` and `search.fetch`.
The backend behind it is DeepSeek: it registers `DeepSeekSearchProvider` and the SSRF-resistant
`HttpFetchProvider` with the provider-neutral `WebRuntime` from `@deepseek-ai/dsh-web`, then calls
`WebRuntime.search()` and `WebRuntime.fetch()` (`ctx.web` in a Harness context). It does not start the
Harness, run an agent/model loop, or invoke the `dsh` CLI. Search returns structured sources; fetch
returns bounded HTML or text content from public HTTP(S) URLs.

The package exports the node class (`DeepSeekSearchNode`, also its default export); it does not build a
bus of its own. The SDK host builds one instance per call, so every call reads the key it uses back
from history before it answers.

```ts
import { servePackage } from '@node-agent/sdk';

const search = await servePackage('.', { url: bus.url, token: bus.token });
```

`npm start` — the same `npx @node-agent/sdk .` the runner uses — takes the standard `NODE_AGENT_BUS_URL`
and `NODE_AGENT_TOKEN` settings. Optional settings are:

- `DEEPSEEK_API_KEY`: DeepSeek credential, unless one is saved on the node's page (see below)
- `DEEPSEEK_SEARCH_BASE_URL`: Anthropic-compatible search endpoint
- `NODE_AGENT_DEEPSEEK_SEARCH_MODEL`: search model (default `deepseek-v4-flash`)
- `NODE_AGENT_DEEPSEEK_SEARCH_API_VERSION`: Anthropic API version
- `NODE_AGENT_DEEPSEEK_SEARCH_MAX_TOKENS`: generated-token limit (default `4096`)
- `NODE_AGENT_DEEPSEEK_SEARCH_MAX_USES`: native search-use limit (default `5`)
- `NODE_AGENT_DEEPSEEK_SEARCH_MAX_RESULTS`: returned-source limit (default `8`)
- `NODE_AGENT_DEEPSEEK_SEARCH_TIMEOUT_MS`: per-search timeout (default `120000`)
- `NODE_AGENT_DEEPSEEK_FETCH_MAX_RESPONSE_BYTES`: response byte limit (default `5000000`)
- `NODE_AGENT_DEEPSEEK_FETCH_MAX_BODY_CHARS`: decoded content limit (default `100000`)
- `NODE_AGENT_DEEPSEEK_FETCH_TIMEOUT_MS`: per-fetch timeout (default `30000`)
- `NODE_AGENT_DEEPSEEK_FETCH_MAX_REDIRECTS`: same-origin redirect limit (default `5`)
- `NODE_AGENT_DEEPSEEK_FETCH_USER_AGENT`: HTTP user agent

The environment keeps its `DEEPSEEK_` names on purpose: the backend really is DeepSeek, and a
variable an operator already sets is not renamed by a node's own name.

Fetch rejects unsafe URLs and non-public destinations, permits only same-origin redirects, and
returns non-2xx HTTP responses as structured results.

## The key, and the page that saves it

The key is not only an environment variable: the node has a page (`/panel/search` in the webui)
with one field, and a `key` capability behind it — `{action: 'status'}` says whether a key is set,
`{action: 'save', api_key}` keeps one, `{action: 'clear'}` forgets it. A saved key is written through the
`history` node (unit `api-key`) and read back before every call, so a restart does not forget it; with
no history node on the bus it lives until the process stops, and the page says which of the two it is.

`key` never answers with the key — only `{configured, source, persistent}`, where `source` is `page`,
`environment` (the one this process was started with) or `none`. A search with no key anywhere fails with
`no DeepSeek API key yet — open the search page and save one`, rather than with the provider's own
missing-credential sentence, which points at a settings screen this node does not have.

## The name it had before

The node used to be called `deepseek-search` (package `node-agent-deepseek-search`). History files
a node's units under that node's own name, so a key saved back then sits under the old name.
**That unit is not read and not moved** — a rename is not a migration; the page asks for a key
again and saves it under `search`.

## Python launcher

The Python package starts this TypeScript node; it does not reimplement search or fetch:

```python
from node_agent_bus import Node, launch_bus
from node_agent_search import launch_search

async with launch_bus() as bus, launch_search(bus) as search:
    client = await Node("caller").join(bus.port, bus.token)
    result = await client.call(
        "search.search", {"query": "What is the latest Node.js release?"}
    )
    page = await client.call("search.fetch", {"url": result["sources"][0]["url"]})
```

Install it with the bus SDK:

```sh
pip install ./packages/node-agent-bus/python ./packages/node-agent-search/python
```
