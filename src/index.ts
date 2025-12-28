/**
 * Scraper MCP Server with x402 Payment Handling
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE_URL = process.env.SCRAPER_API_URL || "http://localhost:8080";

// Check if response is x402
const isX402 = (data: any) => data?.x402Version && data?.accepts;

// Pay for a resource - call /do-payment with the resource URL
async function pay(x402: any): Promise<boolean> {
  const url = x402?.accepts?.[0]?.resource;
  if (!url) return false;
  
  console.error(`[PAY] Paying for: ${url}`);
  try {
    const res = await fetch(`${API_BASE_URL}/do-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    console.error(`[PAY] Result: ${res.ok ? 'SUCCESS' : 'FAILED'}`);
    return res.ok;
  } catch (e) {
    console.error(`[PAY] Error:`, e);
    return false;
  }
}

// Get links - if x402, pay and retry
async function getLinks(url: string, retry = true): Promise<any> {
  console.error(`[LINKS] Fetching: ${url}`);
  const res = await fetch(`${API_BASE_URL}/links?url=${encodeURIComponent(url)}`, {
    headers: { "Accept": "*/*", "User-Agent": "MCP-Scraper/1.0" },
  });
  const data = await res.json();

  if (isX402(data)) {
    console.error(`[LINKS] x402 detected!`);
    if (retry && await pay(data)) {
      return getLinks(url, false); // Retry after payment
    }
  }
  return data;
}

// Extract text - check each result for x402, pay and retry
async function extractText(urls: string[], domain: string, retry = true): Promise<any> {
  console.error(`[EXTRACT] Extracting ${urls.length} URLs for domain: ${domain}`);
  const res = await fetch(`${API_BASE_URL}/extract-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls, domain }),
  });
  const data = await res.json();

  // Check if top-level is x402
  if (isX402(data)) {
    console.error(`[EXTRACT] Top-level x402 detected!`);
    if (retry && await pay(data)) {
      return extractText(urls, domain, false);
    }
    return data;
  }

  // Check if any result inside is x402 - pay for each and retry
  if (data.results && retry) {
    const x402Results = data.results.filter(isX402);
    if (x402Results.length > 0) {
      console.error(`[EXTRACT] Found ${x402Results.length} x402 results inside, paying...`);
      
      // Pay for each x402 resource
      for (const x402 of x402Results) {
        await pay(x402);
      }
      
      // Retry the whole extraction
      return extractText(urls, domain, false);
    }
  }

  return data;
}

// Filter to same domain, exclude socials
function filterUrls(links: string[], domain: string): string[] {
  const socials = ["github.com", "linkedin.com", "instagram.com", "twitter.com", "facebook.com", "youtube.com", "x.com"];
  return links.filter((link) => {
    try {
      const host = new URL(link).hostname.replace("www.", "");
      return !socials.some((s) => host.includes(s)) && host.includes(domain.replace("www.", ""));
    } catch { return false; }
  });
}

// MCP Server
const server = new Server(
  { name: "scraper-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_links",
      description: "Get all links from a URL. Auto-pays x402 if required.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "extract_text", 
      description: "Extract text from URLs. Filters to domain, excludes socials. Auto-pays x402.",
      inputSchema: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" } },
          domain: { type: "string" },
        },
        required: ["urls", "domain"],
      },
    },
    {
      name: "scrape_website",
      description: "Full scrape: get links → filter to domain → extract text. Auto-pays x402.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "get_links") {
    const result = await getLinks(args?.url as string);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "extract_text") {
    const filtered = filterUrls(args?.urls as string[], args?.domain as string);
    if (!filtered.length) return { content: [{ type: "text", text: "No URLs matched domain filter" }] };
    const result = await extractText(filtered, args?.domain as string);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "scrape_website") {
    const url = args?.url as string;
    const domain = new URL(url).hostname.replace("www.", "");

    // Step 1: Get links (auto-pays if x402)
    const links = await getLinks(url);
    if (isX402(links)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Payment failed for links", x402: links }, null, 2) }] };
    }

    // Step 2: Filter to same domain
    const filtered = filterUrls(links.links || [], domain);
    if (!filtered.length) {
      return { content: [{ type: "text", text: JSON.stringify({ links: links.links, filtered: [], message: "No internal links found" }, null, 2) }] };
    }

    // Step 3: Extract text (auto-pays if x402)
    const extracted = await extractText(filtered, domain);
    
    return {
      content: [{ type: "text", text: JSON.stringify({ links, filtered, extracted }, null, 2) }],
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

// Start
const transport = new StdioServerTransport();
server.connect(transport);