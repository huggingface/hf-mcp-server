# Benchmarking and optimization

Benchmark harnesses, production-log analysis utilities, historical score
reports, and measurement-driven optimization plans are maintained separately
from the server implementation in `../hf-mcp-tool-optimisations`.

That repository treats this checkout as a read-only system under test through
`HF_MCP_SERVER_REPO`, and reads explicitly dated production-log snapshots from
`HF_MCP_LOG_ROOT` (normally `~/data/hf-mcp-logs`). Raw logs and model traces are
not part of either repository.

When publishing a result, pin an immutable `hf-mcp-server` commit or tag and
record the benchmark input, generated card, model configuration, scorer, and
artifact hashes. Production behavior changes must still have TypeScript tests
in this repository; benchmark evidence does not replace product tests.

The optimize repository is currently a local Git repository. Add its canonical
remote URL here after it is hosted.
