// 联网工具 schema：web_search / fetch_url / browser_read
// 注意：fetch_url / browser_read 在 function 外层带 recognizer_highlights，
// 供识别器使用，getToolSchemas 会在发给 LLM 前剥离该字段。
export const webSchemas = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current or unknown information. Use this before fetch_url when you do not already know the exact reliable URL. Returns structured JSON with result titles, URLs, snippets, and ok/error status.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Be specific, include product/version/date keywords when relevant.'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return, default 5, max 8.'
          }
        },
        required: ['query']
      }
    }
  },

  fetch_url: {
    type: 'function',
    recognizer_highlights: ['body_path', 'title', 'url', 'content_length'],
    function: {
      name: 'fetch_url',
      description: 'Open a known URL with a lightweight HTTP request. Returns structured JSON with ok/status/title/content/body_path/error. Long articles (>=2000 chars) are auto-saved to sandbox/articles/ and content is truncated to a short excerpt; use the returned body_path with read_file to open the full text. Do not use this tool as a search engine. If ok is false because content is empty, blocked, or JS-rendered, try browser_read or another URL; never summarize an error as page content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open. Prefer reliable source pages found through web_search.'
          }
        },
        required: ['url']
      }
    }
  },

  browser_read: {
    type: 'function',
    recognizer_highlights: ['body_path', 'title', 'url', 'content_length'],
    function: {
      name: 'browser_read',
      description: 'Use a real headless Chromium browser to open and render a webpage, wait for JavaScript, scroll, and extract readable text. Use this when fetch_url returns no readable content, a waiting page, or a JS-rendered page. Returns structured JSON with ok/title/content/body_path/error. Long articles (>=2000 chars) are auto-saved to sandbox/articles/ and content is truncated to a short excerpt; use body_path with read_file to open the full text.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open in the browser.'
          },
          timeout_ms: {
            type: 'number',
            description: 'Navigation/render timeout in milliseconds, default 20000, max 45000.'
          },
          max_chars: {
            type: 'number',
            description: 'Maximum extracted characters to return, default 8000, max 12000.'
          }
        },
        required: ['url']
      }
    }
  },

  deep_research: {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Run a structured deep-research pass on a topic: decompose the question into angles, search multiple sources, fetch the actual page content, and return grouped evidence with sources. Use when the user asks for thorough research, comparison, current info on a topic, or "调研/查一下/研究一下" something and a single search is not enough. The tool does the heavy lifting (multi-search + fetch + evidence collection) and returns structured evidence; YOU then write the final report/conclusion based on that evidence. Long evidence is saved to sandbox/research/ — read it via the report_path if you need the full detail.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The research question or topic, e.g. "2026年主流AI编程助手对比".' },
          sources_per_angle: { type: 'number', description: 'Sources to fetch per search angle, default 3, max 6.' },
          max_content: { type: 'number', description: 'Max content chars to keep per source, default 1200.' },
        },
        required: ['query']
      }
    }
  },

  browser_act: {
    type: 'function',
    recognizer_highlights: ['title', 'url', 'screenshot_path'],
    function: {
      name: 'browser_act',
      description: 'Drive a real interactive browser session (Playwright Chromium) for multi-step tasks that need actual page interaction: navigate, click, fill forms, press keys, select dropdowns, wait, take screenshots, and read the current page. The session PERSISTS across calls, so you can navigate → click → fill → read progressively (e.g. login, fill a form, click through pagination, take screenshots). Use when a task needs real page interaction that fetch_url/browser_read cannot do. After each action it returns a snapshot of the current page (title, url, visible text, interactive elements). End with action=close when the task is done. Do NOT navigate to non-http(s) URLs.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'click', 'fill', 'press', 'select', 'wait', 'screenshot', 'snapshot', 'close'],
            description: 'navigate opens a URL; click clicks an element by CSS selector; fill sets a form field value; press sends a keyboard key (Enter/Tab/Escape/...); select chooses a dropdown option; wait sleeps milliseconds; screenshot saves a PNG to the sandbox; snapshot returns current page state; close ends the browser session.'
          },
          url: { type: 'string', description: 'For navigate: the http(s) URL to open.' },
          selector: { type: 'string', description: 'For click/fill/select: CSS selector of the target element, e.g. "#login-email", "button[type=submit]", "input[name=q]".' },
          value: { type: 'string', description: 'For fill: the text to type into the field. For select: the option value to choose.' },
          key: { type: 'string', description: 'For press: the keyboard key, e.g. Enter, Tab, Escape, ArrowDown.' },
          wait_ms: { type: 'number', description: 'For wait: milliseconds to wait before snapshotting (max 30000).' },
          screenshot_name: { type: 'string', description: 'For screenshot: optional base filename (without extension). Saved under sandbox/screenshots/.' },
          max_chars: { type: 'number', description: 'Optional max visible-text characters in the returned snapshot, default 4000.' },
          timeout_ms: { type: 'number', description: 'Optional per-action timeout in ms, default 20000, max 45000.' }
        },
        required: ['action']
      }
    }
  },
}
