# Ukrainian Law MCP

Ukrainian law database for cybersecurity compliance via Model Context Protocol (MCP).

## Features

- **Full-text search** across legislation provisions (FTS5 with BM25 ranking)
- **Article-level retrieval** for specific legal provisions
- **Citation validation** to prevent hallucinated references
- **Currency checks** to verify if laws are still in force

## Quick Start

### Claude Code (Remote)
```bash
claude mcp add ukrainian-law --transport http https://ukrainian-law-mcp.vercel.app/mcp
```

### Local (npm)
```bash
npx @ansvar/ukrainian-law-mcp
```

## Data Sources

Real legislation ingested from the official Verkhovna Rada legal portal: https://zakon.rada.gov.ua

## License

Apache-2.0
