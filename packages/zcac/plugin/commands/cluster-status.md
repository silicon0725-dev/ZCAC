---
description: Show the status of the most recent ZCAC cluster run
---
Call the `mcp__zcac__cluster_status` MCP tool (no runId needed — it defaults to the most recent run) and present:
- run status (created/running/completed/failed/cancelled) and whether it is still active
- task counts by status
- the last 10 journal events as a compact timeline
If the run is still running, tell the user which tasks are in flight and do nothing else.
