---
description: Stop the most recent ZCAC cluster run
---
Call the `mcp__zcac__cluster_stop` MCP tool to abort the in-flight agents of the most recent run and mark it cancelled. Completed tasks stay immutable. Report the result and remind the user that the run can be inspected afterwards with `mcp__zcac__task_list` and `mcp__zcac__events`.
